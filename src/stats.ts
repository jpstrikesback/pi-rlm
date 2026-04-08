import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { findBootstrapSnapshot, findLatestSnapshot } from "./restore.js";
import { DEFAULT_RLM_PROMPT_MODE, findRlmPromptMode } from "./prompt-mode.js";
import { ensureWorkspaceShape } from "./workspace.js";
import type { RlmPromptMode, RlmSessionStats, RuntimeSnapshot } from "./types.js";

const EMPTY_SNAPSHOT: RuntimeSnapshot = {
	version: 1,
	bindings: {},
	entries: [],
};

function findRlmModeEnabled(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== "rlm-mode") continue;
		const data = entry.data as { enabled?: boolean } | undefined;
		return !!data?.enabled;
	}
	return false;
}

function getVarCount(snapshot: RuntimeSnapshot): number {
	if (snapshot.entries?.length) return snapshot.entries.length;
	return Object.keys(snapshot.bindings || {}).length;
}

function getActiveContextRefCount(snapshot: RuntimeSnapshot): number {
	const workspace = snapshot.bindings.workspace;
	if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return 0;
	const normalized = ensureWorkspaceShape(workspace);
	return normalized.activeContext?.currentArtifactRefs?.length ?? normalized.meta?.activeArtifactRefs?.length ?? 0;
}

export function collectRlmSessionStats(
	ctx: ExtensionContext,
	options: { depth: number; maxDepth: number },
	runtimeSnapshot?: RuntimeSnapshot,
): RlmSessionStats {
	const branch = ctx.sessionManager.getBranch();
	let execCount = 0;
	let childQueryCount = 0;
	let childTurns = 0;
	let leafToolCount = 0;

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (message.toolName === "rlm_exec") {
			execCount += 1;
			const details = message.details as { childQueryCount?: number; childTurns?: number } | undefined;
			childQueryCount += details?.childQueryCount ?? 0;
			childTurns += details?.childTurns ?? 0;
			continue;
		}
		if (message.toolName === "rlm_inspect" || message.toolName === "rlm_reset") continue;
		leafToolCount += 1;
	}

	const promptMode: RlmPromptMode = findRlmPromptMode(ctx) ?? DEFAULT_RLM_PROMPT_MODE;
	const snapshot = runtimeSnapshot ?? findLatestSnapshot(ctx) ?? findBootstrapSnapshot(ctx) ?? EMPTY_SNAPSHOT;

	return {
		enabled: findRlmModeEnabled(ctx),
		promptMode,
		depth: options.depth,
		maxDepth: options.maxDepth,
		execCount,
		childQueryCount,
		childTurns,
		runtimeVarCount: getVarCount(snapshot),
		activeContextRefCount: getActiveContextRefCount(snapshot),
		leafToolCount,
	};
}
