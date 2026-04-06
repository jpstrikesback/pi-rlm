# Shared workspace externalization and metadata layer

## Goal

Make parent, child, and descendant RLM runtimes use the same internal state contract without changing the public API.

Public API remains:

- `rlm_exec`
- `rlm_inspect`
- `rlm_reset`
- `llmQuery({ prompt, role, state, tools, budget, output })`

## Why

The RLM paper emphasizes a different pattern from normal agent scaffolds:

- full prompt/state/intermediate values live in external persistent state
- model history gets compact metadata, not repeated raw blobs
- metadata should tell the model what exists and how to access it

For `pi-turtle-rlm`, that means:

- `globalThis.workspace` should be the durable notebook everywhere
- child prompts should receive manifests/indexes, not ad hoc raw state dumps
- child outputs should become reusable artifacts in the same workspace
- parent and children should share the same runtime access paths

## Internal state contract

### Durable workspace

All long-lived coordination state lives in `globalThis.workspace`.

Canonical sections:

- `workspace.goal`
- `workspace.plan`
- `workspace.files`
- `workspace.findings`
- `workspace.openQuestions`
- `workspace.partialOutputs`
- `workspace.childArtifacts`
- `workspace.artifactIndex`
- `workspace.meta`

Children and descendants use the same contract.

### Child-local input

Each child also gets caller-provided local input restored into:

- `globalThis.parentState`
- `globalThis.input`

These are aliases for the caller-provided `llmQuery(...).state` payload.

## Artifact model

Child results are persisted as structured artifacts.

Each child artifact includes at least:

- stable id (`id`, aliased by `childId` for compatibility)
- kind (`child-query`)
- role
- status
- depth
- turns
- prompt
- answer / summary / parsed data / error
- produced timestamp
- optional tags/files
- optional workspace snapshot / runtime snapshot

Workspace keeps both:

- `workspace.childArtifacts` as the bounded artifact list
- `workspace.artifactIndex` for lookup by id, tag, file, and recency

## Metadata / manifest layer

Prompts should not carry the full workspace or full parent state by default.
They should carry a stable manifest describing:

- which sections exist
- types
- counts / key counts
- small previews
- recent / relevant artifact references
- runtime access paths (`globalThis.workspace`, `globalThis.parentState`, `globalThis.input`)

This metadata is an index to runtime state, not a replacement for runtime state.

## Prompt contract

Child prompts should explicitly say:

- durable notebook: `globalThis.workspace`
- caller-provided local state: `globalThis.parentState`
- input alias: `globalThis.input`
- prompt metadata is only an index to runtime state
- reuse existing workspace/artifacts before re-deriving work
- if using `rlm_exec`, store reusable intermediate findings back into `globalThis.workspace`

## Runtime transfer contract

When a parent runtime calls `llmQuery(...)`:

1. the live parent workspace is attached internally to the child request
2. the child runtime is seeded with that workspace plus `parentState`
3. child prompt generation uses manifests built from that workspace/state
4. child result includes an internal artifact
5. parent runtime records that artifact into `globalThis.workspace`

This preserves a single internal state API across recursion levels.

## Selection / relevance rules

Prompt metadata should stay compact.

Initial heuristic:

- `scout`: emphasize `files`, `findings`, recent artifacts
- `planner`: emphasize `goal`, `plan`, `openQuestions`, `partialOutputs`
- `worker`: emphasize `files`, `findings`, `partialOutputs`, relevant artifacts
- `reviewer`: emphasize `findings`, `partialOutputs`, recent artifacts
- `general`: balanced mix of core sections

Artifacts are ranked using prompt-token overlap with summary/files/tags plus recency.

## Implementation steps

Tracked against the current tree (`src/types.ts`, `src/workspace.ts`, `src/llm-query.ts`, `src/recursion.ts`, `src/runtime.ts`, `tests/*.test.ts`).

- [x] Introduce internal types for workspace state, artifacts, and manifests so the rest of the code has a single shape to work with.
- [x] Add a `workspace` helper module that normalizes workspace data, records and indexes artifacts, builds manifests, picks relevant artifacts for prompts, and carries hidden runtime context on `llmQuery` without leaking it into user-visible text.
- [x] When spawning a child session, give it the parent’s live workspace so it starts from the same ground truth.
- [x] Stop dumping raw child prompt state; drive child prompts from the manifest instead (metadata plus how to read what matters).
- [x] When `maxTurns` finalization runs, use that same workspace contract so nothing special-cases “end of turn” differently from normal recursion.
- [x] Extend tests to cover the helpers, prompt wiring, runtime artifact recording, and restore paths so regressions are obvious.

## Non-goals

- no new public API
- no explicit user-facing artifact resume API yet
- no cross-session remote object store yet

## Success criteria

- parent and descendants all read state from the same runtime paths
- child prompts use metadata + access instructions, not raw dumps
- child work is reusable through indexed workspace artifacts
- typecheck, unit tests, and smoke pass
