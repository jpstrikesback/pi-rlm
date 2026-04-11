<p align="center">
  <img src="https://raw.githubusercontent.com/jpstrikesback/pi-rlm/main/assets/turtle.svg" alt="Fractal LLM turtle logo" width="160" />
</p>

# pi-turtle-rlm

**Recursive language model runtime for [Pi](https://github.com/mariozechner/pi-coding-agent)** — a persistent JS workspace inside the agent, with paper-style runtime helpers, structured child calls, and execution profiles.

> **[Turtles all the way down](https://arxiv.org/abs/2512.24601)** — each turtle is an `rlm_query` call, each shell is `globalThis`, base case `maxDepth`, or just run out of tokens.

[![npm version](https://img.shields.io/npm/v/pi-turtle-rlm.svg)](https://www.npmjs.com/package/pi-turtle-rlm)
[![License](https://img.shields.io/npm/l/pi-turtle-rlm.svg)](./LICENSE)

## Install

**Recommended — Pi package manager** (see [Pi packages](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/packages.md)):

```bash
pi install npm:pi-turtle-rlm
```

Pin a version:

```bash
pi install npm:pi-turtle-rlm@0.1.0
```

**From git:**

```bash
pi install git:github.com/jpstrikesback/pi-rlm
```

**From a local clone** (contributors or vendoring):

```bash
git clone https://github.com/jpstrikesback/pi-rlm.git
cd pi-rlm
npm install
npm run build
pi install ./
# or one-off during development: pi -e ./index.ts
```

**Project-local Pi config** (`.pi/settings.json` or `pi install -l`):

```json
{
	"packages": ["npm:pi-turtle-rlm"]
}
```

After install, start Pi as usual from your repo; the extension loads from Pi’s package resolution. Use `/reload` after upgrading the package.

## Quick start

1. Turn RLM on: `/rlm`
2. Same command takes subcommands:
   - `/rlm profile <name>` — switch active execution profile
   - `/rlm profile list` — list configured profiles
   - `/rlm profile` — open a profile submenu in interactive mode
   - `/rlm profile add <name> <json>` — add or overwrite a profile in the project `.pi/agent/rlm-config.json` (or the explicit config path, if configured)
   - `/rlm profile clone <from> <to>` — clone any resolved profile into a user-defined profile
   - `/rlm profile inspect [name]` — show profile details in a compact JSON view (active profile if omitted)
   - `/rlm profile remove <name>` — remove a user-defined profile
   - `/rlm inspect` — runtime globals
   - `/rlm reset` — clear runtime

For the full configuration surface (profile schema, flag matrix, path precedence, and command side effects), see [`docs/rlm-configuration-api.md`](./docs/rlm-configuration-api.md).

User profiles can be managed either via the command above or by editing `.pi/agent/rlm-config.json` in your project or home Pi agent folder.
By default, `add` writes to the project config file; if an explicit config path is configured, it writes there instead.
If the target file does not exist, `add` creates the config directory and file when possible.
Typing `/rlm profile ...` now exposes profile subcommand options in the Pi slash menu.

When RLM is on you get a pink **RLM PROFILE** widget (active profile name) and footer stats: depth, `rlm_exec` count, child queries / turns, runtime variable count, and non-RLM tool calls (“leaf” count).

## Why RLM?

The goal of Pi Turtle RLM is to:

1. treat the prompt as an **external object in a persistent programming environment**
2. give the root model only **small metadata / symbolic handles** to that object
3. make the model do real work through **code, variables, and programmatic recursive calls**
4. keep intermediate state in **buffers / variables**, not in root transcript replay
5. replay only **small metadata** about execution, not raw prompt/tool payloads

In order to make large refactors easier for models to perform.

Concretely, this extension gives the model a persistent runtime/workspace, lets it externalize intermediate state instead of repeatedly restating it in chat, recurse with `rlm_query`, use lightweight helper calls with `llm_query`, and carry forward compact working-set metadata rather than replaying the full raw transcript.

## Tools

Public RLM tools:

- `rlm_exec` — run JS in the persistent runtime
- `rlm_inspect` — inspect runtime globals
- `rlm_reset` — clear the runtime

Public runtime primitives inside `rlm_exec`:

- `context`
- `history`, plus `history_0 ... history_n`
- `inspectGlobals()`
- `SHOW_VARS()`
- `final(value)`
- `llm_query(...)`
- `llm_query_batched(...)`
- `rlm_query(...)`
- `rlm_query_batched(...)`
- `globalThis.workspace.commit({ goal, plan, files, findings, openQuestions, partialOutputs })`

Also available for compatibility:

- `llmQuery(...)` — legacy alias of `rlm_query(...)`
- `FINAL(...)`
- `FINAL_VAR(...)`

## Use in an extension

```ts
import rlmExtension from "pi-turtle-rlm";

export default rlmExtension;
```

Or configure defaults:

```ts
import { createRlmExtension } from "pi-turtle-rlm";

export default createRlmExtension({
	maxDepth: 3,
	profile: "inherit-parent-class",
	profiles: {
		// Optional overrides for built-in defaults
		"my-fast-profile": {
			behavior: {
				guidanceVariant: "default",
				taskFewShotVariant: "artifact-workflow-neutral-v1",
				rootKickoffVariant: "recursive-scout-v1",
				directToolBias: "high",
				runtimeBias: "medium",
				recursiveBias: "low",
			},
			helpers: {
				simpleChild: { defaultModel: "openai-codex/gpt-5.4-nano:off" },
				recursiveChild: { inheritParentByDefault: true },
			},
		},
	},
});
```

## Safety

The worker uses `node:vm` with several globals stripped. It is **not** a security sandbox — treat it like running code in your user account.

## Advanced runtime usage

Inside `rlm_exec`, the runtime exposes:

- `llm_query(...)` for simple one-turn child calls with no RLM extension or tools
- `rlm_query(...)` for recursive child sessions with workspace/artifact support
- `llmQuery(...)` as the legacy alias of `rlm_query(...)`
- exact per-call submodel selectors via `provider/id[:thinking]`

Simple one-shot subcall:

```ts
await llm_query("Extract the config flags", {
	model: "openai-codex/gpt-5.4-mini",
	output: { mode: "json" },
});
```

Recursive child call:

```ts
await rlm_query({
	prompt: "Analyze the auth module",
	state: { files: globalThis.authFiles },
	tools: "read-only",
	budget: "medium",
	model: "openai-codex/gpt-5.4-mini",
});
```

## Inspiration

This project is inspired in part by AxLLM’s RLM ideas.

## Development

```bash
git clone https://github.com/jpstrikesback/pi-rlm.git
cd pi-rlm
npm install
npm test
npm run build
npm run smoke
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
