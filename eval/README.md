# Eval harness

Pi-native evaluation harness for this repo.

## Purpose

Benchmark every meaningful change to `pi-turtle-rlm`.

The harness is built to compare:

- a **baseline** extension artifact
- a **candidate** extension artifact

while keeping the rest stable:

- pinned local Pi version from `node_modules/@mariozechner/pi-coding-agent`
- the same benchmark scenarios
- the same repo corpus + local Pi docs/examples
- the same upstream provider/model setup for both subjects

## Pi-native observation

That means:

- Pi resolves the real model/provider/auth setup
- the eval runner does **not** replace provider transport in the default path
- telemetry is captured from inside Pi via `pi-spy`
- baseline vs candidate still compares built extension artifacts

`pi-spy` is passed explicitly to the eval command via `--spy-entrypoint`.

It records provider payload, tool activity, message usage, and turn outcomes, etc while Pi does the actual work.

## Provider profiles

Provider profiles are still kept as metadata/hints for scenario grouping and future transport-specific work, but the default runner path is now Pi-native.

Current profiles:

- `mlx` — `mlx_lm.server` via OpenAI-compatible chat/completions
- `openai-chat` — OpenAI-compatible chat/completions
- `openai-responses` — OpenAI Responses API

The provider profile is currently used to:

- label eval runs consistently
- provide default provider lookup candidates when resolving models/auth
- keep scenario grouping stable across runs

## Normalized metrics

The harness normalizes provider usage into the same output fields:

- `promptTokens`
- `completionTokens`
- `totalTokens`
- `cacheHitTokens`
- `cacheMissTokens`

Token metrics are derived from Pi-native assistant usage events captured by `pi-spy`, then normalized into the fields above for comparison output.

## Scenarios

List scenarios:

```bash
npm run eval:list
```

Current scenarios are focused on **Pi extension building using RLM** and are meant to exercise:

- root runtime reuse
- recursive child work
- prompt construction behavior
- realistic extension-builder workflows

## Usage

### 1) Run a single subject

Using your normal Pi model/auth setup:

```bash
npm run build
npm run eval -- \
  --subject ./dist/index.js \
  --spy-entrypoint ../pi-spy/src/index.ts \
  --scenario extension-research \
  --model-id gpt-5.4-mini \
  --auth-provider openai-codex
```

If model ids exist under multiple providers, pin the provider explicitly:

```bash
npm run eval -- \
  --subject ./dist/index.js \
  --spy-entrypoint ../pi-spy/src/index.ts \
  --scenario extension-research \
  --model-id gpt-5.4-mini \
  --model-provider openai-codex
```

### 2) Snapshot a baseline artifact

```bash
npm run build
npm run eval:baseline -- --name main
```

This copies `./dist` to `./eval/artifacts/main/dist`.

### 3) Compare baseline vs candidate

```bash
npm run build
npm run eval:compare -- \
  --baseline ./eval/artifacts/main/dist/index.js \
  --candidate ./dist/index.js \
  --spy-entrypoint ../pi-spy/src/index.ts \
  --scenario rlm-refactor-review \
  --model-id gpt-5.4-mini \
  --auth-provider openai-codex
```

## Auth and provider configuration notes

By default, the harness uses your **regular Pi agent directory** for auth and `models.json` resolution.

That means it will read from the same Pi auth/models setup you normally use via `getAgentDir()` (typically `~/.pi/agent`).

Important nuance:

- auth/models come from your regular Pi agent dir by default
- benchmark session state is still isolated per eval run
- so you get normal provider credentials without polluting your day-to-day session state
- Pi auth from the shared agent dir is consulted first; if you want to bypass it and force a literal/env API key for the harness, use `--isolated-auth true`

Options:

- pass the `pi-spy` extension entrypoint explicitly with:
  - `--spy-entrypoint /path/to/pi-spy/src/index.ts`
- override the Pi agent dir with:
  - `--agent-dir /path/to/agent`
- override the auth provider name looked up in shared Pi auth with:
  - `--auth-provider openai-codex`
- force fully isolated auth/models with:
  - `--isolated-auth true`
- choose an exact model provider with:
  - `--model-provider openai-codex`
- inject a runtime API key for the resolved provider with:
  - `--api-key sk-...`
- mark the eval run as reasoning-oriented with:
  - `--reasoning true`

## Output

Results are written under:

- `eval/results/.../result.json`
- `eval/results/.../summary.md`
- `eval/results/.../compare.json`
- `eval/results/.../compare.md`

The harness records:

- per-turn request counts
- provider-normalized prompt/completion/cache token usage
- prompt prefix similarity between consecutive turns
- tool counts
- `rlm_exec` counts
- child query/turn counts surfaced by `rlm_exec`
- assistant output previews for human review

## Notes

- The harness runs against built extension artifacts, not source files.
- This keeps A/B comparisons honest and close to what Pi actually loads.
- For stable comparisons, use the same provider profile, upstream, and model setup for both subjects.
- Current RLM-heavy eval scenarios prefer profile-driven defaults, for example via `rlm-profile=openai-5.4-class` to align child helper selection with the scenario's built-in profile policy.
