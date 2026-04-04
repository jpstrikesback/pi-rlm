import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RuntimeSnapshot } from "./types.js";

export const RLM_WORKSPACE_TYPE = "rlm-workspace";

export function getSessionRuntimeKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export function findLatestSnapshot(ctx: ExtensionContext): RuntimeSnapshot | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role !== "toolResult") continue;
			if (message.toolName !== "rlm_exec" && message.toolName !== "rlm_reset") continue;
			const details = message.details as { snapshot?: RuntimeSnapshot } | undefined;
			if (details?.snapshot) return details.snapshot;
		}
		if (entry.type === "custom" && entry.customType === "rlm-runtime") {
			const data = entry.data as { snapshot?: RuntimeSnapshot } | undefined;
			if (data?.snapshot) return data.snapshot;
		}
	}
	return undefined;
}

export function findLatestWorkspace(ctx: ExtensionContext): Record<string, unknown> | null | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== RLM_WORKSPACE_TYPE) continue;
		const data = entry.data as { workspace?: unknown } | undefined;
		if (data?.workspace === null) return null;
		if (data?.workspace && typeof data.workspace === "object") return data.workspace as Record<string, unknown>;
	}
	return undefined;
}

export function composeRuntimeSnapshot(
	snapshot: RuntimeSnapshot | undefined,
	workspace: Record<string, unknown> | null | undefined,
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
