<p align="center">
  <img src="https://raw.githubusercontent.com/jpstrikesback/pi-rlm/main/assets/turtle.svg" alt="Fractal LLM turtle logo" width="160" />
</p>

# pi-turtle-rlm

**Recursive language model runtime for [Pi](https://github.com/mariozechner/pi-coding-agent)** — a persistent JS workspace inside the agent, with structured child calls via `llmQuery`, prompt modes, and session stats.

> **[Turtles all the way down](https://arxiv.org/abs/2512.24601)** — each turtle is an `llmQuery` call, each shell is `globalThis`, base case `maxDepth`, or just run out of tokens.

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
   - `/rlm balanced` | `/rlm coordinator` | `/rlm aggressive` — prompt mode
   - `/rlm inspect` — runtime globals
   - `/rlm reset` — clear runtime

When RLM is on you get a pink **RLM MODE** widget (with mode label) and footer stats: depth, `rlm_exec` count, child queries / turns, runtime variable count, and non-RLM tool calls (“leaf” count).

## Why RLM?

Large refactors need more room for context than a single chat transcript. A normal agent loop is fine for small edits; it is weaker at keeping a **changing working set** coherent across many steps.

This extension gives the model a place to:

- hold intermediate state
- build buffers and summaries
- recurse on subproblems with `llmQuery`
- keep derived data out of prose
- resume without re-deriving everything

## Why Pi?

Pi already provides tools, sessions, forks, restore, slash commands, and UI hooks — so the runtime plugs in as an extension instead of a separate shell.

## `llmQuery` API

Recursive calls run inside a real Pi child session, so the request is one structured object:

- **`prompt`** — child task (required)
- **`state`** — structured parent → child payload (also surfaced as `globalThis.input` / `globalThis.parentState`)
- **`tools`** — `"read-only"` | `"coding"` | `"same"` | explicit built-in list
- **`budget`** — `"low"` | `"medium"` | `"high"` or `{ maxDepth?, maxTurns? }`
- **`output`** — `{ mode?: "text" | "json", schema?: Record<string, string> }`

Example:

```ts
await llmQuery({
	prompt: "Analyze the auth module",
	state: {
		files: globalThis.authFiles,
		previousSummary: globalThis.authSummary,
	},
	tools: "read-only",
	budget: "medium",
	output: {
		mode: "json",
		schema: {
			summary: "string",
			relevantFiles: "string[]",
			findings: "string[]",
		},
	},
});
```

### Types (exported from the package)

```ts
type LlmQueryRequest = {
	prompt: string;
	role?: "general" | "scout" | "planner" | "worker" | "reviewer";
	state?: Record<string, unknown>;
	tools?: "read-only" | "coding" | "same" | Array<"read" | "bash" | "edit" | "write" | "grep" | "find" | "ls">;
	budget?: "low" | "medium" | "high" | { maxDepth?: number; maxTurns?: number };
	output?: { mode?: "text" | "json"; schema?: Record<string, string> };
};

type LlmQueryResult = {
	ok: boolean;
	answer: string;
	summary?: string;
	data?: Record<string, unknown>;
	role?: LlmQueryRole;
	usage?: { turns?: number };
	error?: string;
};
```

With `output.mode === "json"`, parsed JSON is in `result.data`.

## Tools exposed to the model

| Tool          | Role                                               |
| ------------- | -------------------------------------------------- |
| `rlm_exec`    | Run JS in the persistent VM; `llmQuery` lives here |
| `rlm_inspect` | Inspect `globalThis` / runtime table               |
| `rlm_reset`   | Clear the runtime                                  |

Inside `rlm_exec`:

- `inspectGlobals()`
- `final(value)` — return a structured “result” for the tool
- `await llmQuery(request)`

## Runtime model

- One `worker_threads` VM per Pi session key
- State is snapshotted as structured-cloneable globals
- Snapshots restore on session restore, tree navigation, and fork
- `globalThis.workspace` is also persisted as a dedicated branch-aware custom entry so it survives resume, `/tree`, and `/fork` as the durable coordination root
- Child bootstrap uses `globalThis.input` / `globalThis.parentState`

## Programmatic default export

```ts
import rlmExtension from "pi-turtle-rlm";

export default rlmExtension;
```

Factory with options:

```ts
import { createRlmExtension } from "pi-turtle-rlm";

export default createRlmExtension({
	maxDepth: 3,
	promptMode: "coordinator",
});
```

Exported types include `RlmExtensionOptions`, `LlmQueryRequest`, `LlmQueryResult`, `RuntimeSnapshot`, `GlobalsInspection`, and related session/prompt-mode types.

## Safety

The worker uses `node:vm` with several globals stripped. It is **not** a security sandbox — treat it like running code in your user account.

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
