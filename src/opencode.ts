import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { BootstrapResponse, ManagerClient } from "./sdk.js";

export interface RunOpencodeArgs {
  client: ManagerClient;
  bootstrap: BootstrapResponse;
  prompt: string;
  payload: Record<string, unknown>;
  workdir?: string;
  authDir?: string;
}

export interface ProviderResolution {
  provider: "anthropic" | "openai" | "openrouter" | "groq" | "amazon-bedrock";
  secretKey: string;
  model: string;
}

const DEFAULT_MODEL = "anthropic/claude-3-5-sonnet-latest";

const PROVIDER_TABLE: Record<
  string,
  { provider: ProviderResolution["provider"]; secretKey: string }
> = {
  anthropic: { provider: "anthropic", secretKey: "ANTHROPIC_API_KEY" },
  openai: { provider: "openai", secretKey: "OPENAI_API_KEY" },
  openrouter: { provider: "openrouter", secretKey: "OPENROUTER_API_KEY" },
  groq: { provider: "groq", secretKey: "GROQ_API_KEY" },
  // Bedrock authenticates via the ECS task role (or local AWS_* env), no api key.
  "amazon-bedrock": { provider: "amazon-bedrock", secretKey: "" },
};

export function resolveProvider(model: string): ProviderResolution | null {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const prefix = model.slice(0, slash);
  const entry = PROVIDER_TABLE[prefix];
  if (!entry) return null;
  return { provider: entry.provider, secretKey: entry.secretKey, model };
}

interface LogEvent {
  ts: string;
  level: string;
  message: string;
  [k: string]: unknown;
}

export async function runOpencode(args: RunOpencodeArgs): Promise<void> {
  const { client, bootstrap, prompt, payload } = args;
  const workdir = args.workdir ?? "/work";
  const authDir =
    args.authDir ?? `${process.env.HOME ?? "/root"}/.local/share/opencode`;

  const requestedModel =
    typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : DEFAULT_MODEL;

  const resolution = resolveProvider(requestedModel);
  if (!resolution) {
    await client.fail({
      code: "agent.unknown_secret_key",
      message: `missing provider key for model ${requestedModel}`,
    });
    return;
  }

  // Bedrock uses IAM (task role on ECS, AWS_* env locally), not a vault api
  // key. opencode still needs an entry in auth.json so its provider router
  // routes the request to the bedrock SDK path; credentials are picked up by
  // the AWS SDK default chain.
  mkdirSync(authDir, { recursive: true });
  const authPath = join(authDir, "auth.json");
  if (resolution.provider === "amazon-bedrock") {
    writeFileSync(
      authPath,
      JSON.stringify({ "amazon-bedrock": { type: "bedrock" } }),
      { mode: 0o600 },
    );
  } else {
    const apiKey = bootstrap.secrets[resolution.secretKey];
    if (!apiKey) {
      await client.fail({
        code: "agent.unknown_secret_key",
        message: `missing provider key for model ${requestedModel}`,
      });
      return;
    }
    writeFileSync(
      authPath,
      JSON.stringify({ [resolution.provider]: { type: "api", key: apiKey } }),
      { mode: 0o600 },
    );
  }

  // Ensure workdir
  mkdirSync(workdir, { recursive: true });

  // Set up batched log queue
  const queue: LogEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> = Promise.resolve();
  const flush = async (): Promise<void> => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    try {
      await client.pushLogs(batch);
    } catch {
      /* don't fail run on log loss */
    }
  };
  const enqueue = (e: LogEvent): void => {
    queue.push(e);
    if (queue.length >= 50) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushing = flushing.then(() => flush());
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushing = flushing.then(() => flush());
      }, 1000);
    }
  };

  // Track last result + last stderr line
  let lastResult: Record<string, unknown> | null = null;
  let lastParsed: Record<string, unknown> | null = null;
  let lastStderr = "";

  // For bedrock, ensure AWS_REGION is set even when ECS only set
  // AWS_DEFAULT_REGION; the bedrock SDK reads AWS_REGION first.
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  if (resolution.provider === "amazon-bedrock") {
    spawnEnv.AWS_REGION =
      spawnEnv.AWS_REGION ?? spawnEnv.AWS_DEFAULT_REGION ?? "us-east-1";
    spawnEnv.AWS_DEFAULT_REGION = spawnEnv.AWS_REGION;
  }

  const child = spawn(
    "opencode",
    [
      "run",
      prompt,
      "--format",
      "json",
      "--print-logs",
      "--log-level",
      "INFO",
      "--dangerously-skip-permissions",
      "--model",
      resolution.model,
    ],
    { cwd: workdir, env: spawnEnv },
  );

  const stdoutRl = createInterface({ input: child.stdout });
  stdoutRl.on("line", (line: string) => {
    const ts = new Date().toISOString();
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsed = v as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
    if (parsed) {
      lastParsed = parsed;
      if (parsed.type === "result") {
        lastResult = parsed;
      }
      enqueue({ ts, level: "info", message: "opencode", ...parsed });
    } else {
      enqueue({ ts, level: "info", message: line });
    }
  });

  const stderrRl = createInterface({ input: child.stderr });
  stderrRl.on("line", (line: string) => {
    if (line.length > 0) lastStderr = line;
    enqueue({ ts: new Date().toISOString(), level: "error", message: line });
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  // Final flush
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushing;
  await flush();

  if (exitCode !== 0) {
    await client.fail({
      code: "provider.failed",
      message: lastStderr || `opencode exited with code ${exitCode}`,
      detail: { exitCode },
    });
    return;
  }

  // Walk artifacts
  const outDir = join(workdir, ".am-out");
  if (existsSync(outDir)) {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    for (const abs of walk(outDir)) {
      const key = relative(outDir, abs);
      try {
        await client.uploadArtifact(key, readFileSync(abs));
      } catch {
        /* swallow individual artifact upload errors */
      }
    }
  }

  const result = lastResult ?? lastParsed ?? { ok: true };
  await client.complete(result);
}
