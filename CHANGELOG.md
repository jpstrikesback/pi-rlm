# Changelog

## [Unreleased]

### Changed

- When a child `llmQuery` hits `maxTurns`, RLM now restores the child state internally and runs a final no-tools pass before returning, reducing empty child results.
- README is now more usage-focused and keeps advanced runtime details lower in the document.
- Replaced the old smoke script with a real Pi CLI integration smoke test.

### Fixed

- Child queries that exhausted their turn budget are less likely to return ambiguous empty output.

## [0.1.2] - 2026-04-04

### Added

- Live `rlm_exec` progress rendering for child `llmQuery` activity inside the Pi tool row.
- Child lifecycle tracking for recursive queries, including start, turn, tool activity, completion, and error states.
- Durable `globalThis.workspace` persistence via Pi `custom` entries (`rlm-workspace`).
- Restore-time workspace overlay on top of runtime snapshots.
- Restore logic that marks `workspace.children[*].status === "running"` as `"interrupted"` in memory.
- Tests for workspace lookup and snapshot/workspace restore composition.

### Changed

- `rlm_exec` now streams partial UI updates while recursive child work is running.
- `globalThis.workspace` now follows Pi session history semantics across resume, `/tree`, and `/fork`.
- Workspace persistence now skips writing a new `rlm-workspace` entry when the workspace value is unchanged.

### Fixed

- Reduced duplicate persisted workspace entries when no durable workspace state changed.

## [0.1.1] - 2026-04-04

### Added

- Published package metadata for `pi-turtle-rlm`.
- Built distribution export via `dist/index.js`.
- README installation and package usage updates.

### Included

- Persistent runtime tools: `rlm_exec`, `rlm_inspect`, `rlm_reset`.
- Recursive `llmQuery(...)` support with prompt modes, stats, restore, and tests.
