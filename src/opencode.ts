import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Monitor } from "./sdk/src/monitor.js";
import type { BootstrapResponse, ManagerClient } from "./sdk/src/sdk.js";

export interface RunOpencodeArgs {
  client: ManagerClient;
  bootstrap: BootstrapResponse;
  prompt: string;
  payload: Record<string, unknown>;
  workdir?: string;
  authDir?: string;
  monitor?: Monitor;
}

export interface RunOpencodeResult {
  result?: Record<string, unknown>;
  error?: { code: string; message: string; detail?: Record<string, unknown> };
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

export async function runOpencode(args: RunOpencodeArgs): Promise<RunOpencodeResult> {
  const { client, bootstrap, prompt, payload, monitor } = args;
  const workdir = args.workdir ?? "/work";
  const authDir =
    args.authDir ?? `${process.env.HOME ?? "/root"}/.local/share/opencode`;

  const requestedModel =
    typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : DEFAULT_MODEL;

  const resolution = resolveProvider(requestedModel);
  if (!resolution) {
    return {
      error: {
        code: "agent.unknown_secret_key",
        message: `missing provider key for model ${requestedModel}`,
      },
    };
  }

  mkdirSync(authDir, { recursive: true });
  const authPath = join(authDir, "auth.json");
  if (resolution.provider === "amazon-bedrock") {
    const fs = await import("node:fs");
    fs.writeFileSync(
      authPath,
      JSON.stringify({ "amazon-bedrock": { type: "bedrock" } }),
      { mode: 0o600 },
    );
  } else {
    const apiKey = bootstrap.secrets[resolution.secretKey];
    if (!apiKey) {
      return {
        error: {
          code: "agent.unknown_secret_key",
          message: `missing provider key for model ${requestedModel}`,
        },
      };
    }
    const fs = await import("node:fs");
    fs.writeFileSync(
      authPath,
      JSON.stringify({ [resolution.provider]: { type: "api", key: apiKey } }),
      { mode: 0o600 },
    );
  }

  mkdirSync(workdir, { recursive: true });

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
    monitor?.appendTranscript(JSON.stringify(e));
    monitor?.markActivity();
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

  let lastResult: Record<string, unknown> | null = null;
  let lastParsed: Record<string, unknown> | null = null;
  let lastStderr = "";

  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  if (resolution.provider === "amazon-bedrock") {
    spawnEnv.AWS_REGION = spawnEnv.AWS_REGION ?? spawnEnv.AWS_DEFAULT_REGION ?? "us-east-1";
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

  monitor?.markActivity();
  enqueue({
    ts: new Date().toISOString(),
    level: "info",
    message: "opencode spawned",
    provider: resolution.provider,
    model: resolution.model,
    pid: child.pid,
  });

  if (monitor) {
    monitor.bindStallKill?.(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* swallow */
      }
    });
  }

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

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushing;
  await flush();

  if (exitCode !== 0) {
    return {
      error: {
        code: "provider.failed",
        message: lastStderr || `opencode exited with code ${exitCode}`,
        detail: { exitCode },
      },
    };
  }

  // Prefer the agent's .am-out/result.json. Fall back to last opencode
  // `type=result` event payload.
  let result: Record<string, unknown> = lastResult ?? lastParsed ?? { ok: true };
  try {
    const buf = readFileSync(`${workdir}/.am-out/result.json`);
    const parsed = JSON.parse(buf.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      result = parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }

  return { result };
}
