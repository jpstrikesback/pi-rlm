import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RlmPromptMode } from "./types.js";

export const RLM_PROMPT_MODE_TYPE = "rlm-prompt-mode";
export const DEFAULT_RLM_PROMPT_MODE: RlmPromptMode = "balanced";

const MODE_LABELS: Record<RlmPromptMode, string> = {
	balanced: "BALANCED",
	coordinator: "COORDINATOR",
	aggressive: "AGGRESSIVE",
};

const MODE_APPENDICES: Record<RlmPromptMode, string> = {
	balanced: `

RLM mode is active.

You have access to a persistent runtime with live variables and recursive child queries.
Treat the runtime as the main workspace when the task needs more room for context than the conversation alone should hold.

Use rlm_exec when:
- the task is multi-file or multi-step
- you need to keep findings, plans, derived data, or partial outputs across turns
- you would otherwise keep re-reading and re-summarizing the same context in prose
- recursive child queries would help with a subproblem

Use direct Pi tools as leaf actions for repository interaction.
Use rlm_exec as the place where you coordinate the task and keep the working set.

Coordinator rules:
- use globalThis.workspace as the main notebook for durable state
- keep large working state in runtime, not prose
- store goal, plan, files, findings, openQuestions, partialOutputs, and childArtifacts under globalThis.workspace when helpful
- treat prompt metadata as an index to runtime state, not as a replacement for runtime state
- before launching new child work, review globalThis.workspace.childArtifacts and reuse or consolidate what is already known
- use llmQuery({ prompt, role, state, tools, budget, output }) for semantic subproblems when useful
- batch child work and avoid many tiny llmQuery calls
`,
	coordinator: `

RLM mode is active.

You are the top-level coordinator of a persistent runtime workspace.
For any multi-file, multi-step, or long-horizon task, begin by opening or updating that workspace in rlm_exec.

Top-level strategy:
1. Start in rlm_exec.
2. Use globalThis.workspace as the main notebook for goal, current plan, files of interest, findings, openQuestions, partialOutputs, and childArtifacts.
3. Use direct Pi tools as leaf actions to inspect or modify the repository.
4. Return to rlm_exec after leaf actions to update and consolidate the workspace.
5. Use llmQuery({ prompt, role, state, tools, budget, output }) for semantic subproblems.
6. Before re-running child analysis, review globalThis.workspace.childArtifacts and merge useful results into workspace.findings or workspace.partialOutputs.
7. Treat prompt metadata as an index to runtime state and inspect globalThis.workspace when details matter.

Important:
- do not keep the main working set in prose when runtime would be better
- do not repeatedly re-read and re-summarize the same context if it can live in runtime
- default child tools to read-only unless mutation is clearly needed
- batch child work; do not spray many tiny child calls
`,
	aggressive: `

RLM mode is active.

You are the top-level coordinator of a persistent runtime workspace.
Unless the task is clearly a one-shot read/edit/write operation, start in rlm_exec and use runtime as the main working memory.

Default workflow:
1. Open rlm_exec first.
2. Create or update globalThis.workspace.goal, globalThis.workspace.plan, globalThis.workspace.files, globalThis.workspace.findings, globalThis.workspace.openQuestions, globalThis.workspace.partialOutputs, and globalThis.workspace.childArtifacts as needed.
3. Use direct Pi tools only as leaf actions.
4. After leaf actions, return to rlm_exec and update or consolidate the workspace.
5. Use llmQuery({ prompt, role, state, tools, budget, output }) selectively for semantic subproblems, but batch work into fewer larger calls.
6. Reuse child artifacts from globalThis.workspace.childArtifacts before re-running child analysis, and fold the important parts back into workspace.findings or workspace.partialOutputs.
7. Treat prompt metadata as an index to runtime state and inspect globalThis.workspace when details matter.

Strong preferences:
- keep conversation prose brief and keep the working set in runtime
- do not repeatedly restate findings that can live in globalThis.workspace
- do not stay in a loop of read/grep/bash without updating the coordinator workspace
- prefer acting like a coordinator with a notebook, not a stateless tool caller
`,
};

export function isRlmPromptMode(value: string): value is RlmPromptMode {
	return value === "balanced" || value === "coordinator" || value === "aggressive";
}

export function getRlmPromptModeLabel(mode: RlmPromptMode): string {
	return MODE_LABELS[mode];
}

export function buildRlmModeAppendix(mode: RlmPromptMode): string {
	return MODE_APPENDICES[mode];
}

export function findRlmPromptMode(ctx: ExtensionContext): RlmPromptMode {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== RLM_PROMPT_MODE_TYPE) continue;
		const data = entry.data as { mode?: string } | undefined;
		if (data?.mode && isRlmPromptMode(data.mode)) return data.mode;
	}
	return DEFAULT_RLM_PROMPT_MODE;
}
