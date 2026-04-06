import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { LlmQueryRole, RuntimeSnapshot, RlmWorkspace } from "./types.js";
import { ensureWorkspaceShape } from "./workspace.js";

export const RLM_RUNTIME_TYPE = "rlm-runtime";
export const RLM_WORKSPACE_TYPE = "rlm-workspace";

function workspaceFromUnknown(value: unknown): RlmWorkspace | null | undefined {
	if (value === null) return null;
	if (value && typeof value === "object" && !Array.isArray(value)) return ensureWorkspaceShape(value);
	return undefined;
}

export function getSessionRuntimeKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export function findLatestSnapshotInBranch(branch: unknown[]): RuntimeSnapshot | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry?.type === "message") {
			const message = entry.message;
			if (message?.role !== "toolResult") continue;
			if (message.toolName !== "rlm_exec" && message.toolName !== "rlm_reset") continue;
			const details = message.details as { snapshot?: RuntimeSnapshot } | undefined;
			if (details?.snapshot) return details.snapshot;
		}
		if (entry?.type === "custom" && entry.customType === RLM_RUNTIME_TYPE) {
			const data = entry.data as { snapshot?: RuntimeSnapshot } | undefined;
			if (data?.snapshot) return data.snapshot;
		}
	}
	return undefined;
}

export function findLatestSnapshot(ctx: ExtensionContext): RuntimeSnapshot | undefined {
	return findLatestSnapshotInBranch(ctx.sessionManager.getBranch());
}

export function findLatestWorkspaceInBranch(branch: unknown[]): RlmWorkspace | null | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry?.type !== "custom" || entry.customType !== RLM_WORKSPACE_TYPE) continue;
		const data = entry.data as { workspace?: unknown } | undefined;
		return workspaceFromUnknown(data?.workspace);
	}
	return undefined;
}

export function findLatestWorkspace(ctx: ExtensionContext): RlmWorkspace | null | undefined {
	return findLatestWorkspaceInBranch(ctx.sessionManager.getBranch());
}

export function buildChildArtifactFromBranch(
	branch: unknown[],
	options: {
		childId: string;
		role: LlmQueryRole;
		depth: number;
		turns: number;
		status: "ok" | "error" | "budget_exhausted";
	},
): {
	version: 1;
	childId: string;
	role: LlmQueryRole;
	depth: number;
	turns: number;
	status: "ok" | "error" | "budget_exhausted";
	snapshot?: RuntimeSnapshot;
	workspace?: RlmWorkspace | null;
} {
	const snapshot = findLatestSnapshotInBranch(branch);
	const latestWorkspace = findLatestWorkspaceInBranch(branch);
	const workspace = latestWorkspace ?? workspaceFromUnknown(snapshot?.bindings?.workspace);
	return {
		version: 1,
		childId: options.childId,
		role: options.role,
		depth: options.depth,
		turns: options.turns,
		status: options.status,
		...(snapshot ? { snapshot } : {}),
		...(workspace !== undefined ? { workspace } : {}),
	};
}

export function composeRuntimeSnapshot(
	snapshot: RuntimeSnapshot | undefined,
	workspace: RlmWorkspace | null | undefined,
): RuntimeSnapshot {
	const next = snapshot ? structuredClone(snapshot) : { version: 1 as const, bindings: {}, entries: [] };
	if (workspace === null) {
		delete next.bindings.workspace;
		return next;
	}
	if (workspace && typeof workspace === "object") {
		next.bindings.workspace = structuredClone(workspace);
	}
	return next;
}

export function findBootstrapSnapshot(ctx: ExtensionContext): RuntimeSnapshot | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== "rlm-child-bootstrap") continue;
		const data = entry.data as { state?: Record<string, unknown> } | undefined;
		if (!data?.state) return undefined;
		return {
			version: 1,
			bindings: {
				input: data.state,
				parentState: data.state,
			},
			entries: [],
		};
	}
	return undefined;
}
