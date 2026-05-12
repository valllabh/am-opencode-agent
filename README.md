# am-opencode-agent

agent-manager sandbox runner that drives an LLM via [`opencode`](https://www.npmjs.com/package/opencode-ai) against API-key based providers (Anthropic, OpenAI, OpenRouter, Groq). API keys are supplied by the manager at bootstrap, sourced from the vault entries listed in `agent.allowedSecretKeys`.

## Repo lives as a submodule

This repo is consumed from the parent agent-manager repo at `sandbox/opencode-agent/` as a git submodule.

## Build

Local (when corp network allows):

```
make docker
```

Remote (canonical): push to `main` triggers AWS CodeBuild project `am-opencode-agent`, which runs `buildspec.yml`, builds the image and pushes it to `agent-manager/sandbox-opencode:latest` and `:<git-sha>` in ECR.

## Runtime contract

The container expects three env vars at start time:

| env | source |
|---|---|
| `TASK_ID` | passed by the api via ECS RunTask container override |
| `MANAGER_URL` | same |
| `BOOTSTRAP_TOKEN` | same |

It calls `POST /v1/bootstrap`, loads skill bodies, writes an `auth.json` with the requested provider's api key, then spawns `opencode run --format json --model <provider>/<model>`.

## Supported model prefixes

`anthropic/`, `openai/`, `openrouter/`, `groq/`. For Bedrock use `am-pi-agent` instead.
