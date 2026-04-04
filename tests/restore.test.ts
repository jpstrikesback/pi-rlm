import { describe, expect, it } from "vitest";
import {
	buildChildHandoffFromBranch,
	composeRuntimeSnapshot,
	findBootstrapSnapshot,
	findLatestSnapshot,
	findLatestSnapshotInBranch,
	findLatestWorkspace,
	findLatestWorkspaceInBranch,
	getSessionRuntimeKey,
	RLM_RUNTIME_TYPE,
	RLM_WORKSPACE_TYPE,
} from "../src/restore.js";
import type { RuntimeSnapshot } from "../src/types.js";

function makeCtx(sessionId: string, branch: unknown[]) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as any;
}

const snapshotA: RuntimeSnapshot = {
	version: 1,
	bindings: { a: 1 },
	entries: [],
};

const snapshotB: RuntimeSnapshot = {
	version: 1,
	bindings: { b: 2 },
	entries: [],
};

describe("restore helpers", () => {
	it("uses the session id as the runtime key", () => {
		expect(getSessionRuntimeKey(makeCtx("session-123", []))).toBe("session-123");
	});

	it("finds the latest snapshot from rlm_exec or rlm_reset tool results", () => {
		const ctx = makeCtx("session-1", [
			{
				type: "message",
				message: { role: "toolResult", toolName: "rlm_exec", details: { snapshot: snapshotA } },
			},
			{
				type: "message",
				message: { role: "toolResult", toolName: "read", details: {} },
			},
			{
				type: "message",
				message: { role: "toolResult", toolName: "rlm_reset", details: { snapshot: snapshotB } },
			},
		]);

		expect(findLatestSnapshot(ctx)).toEqual(snapshotB);
	});

	it("falls back to the latest custom rlm-runtime snapshot entry", () => {
		const ctx = makeCtx("session-1", [
			{
				type: "custom",
				customType: RLM_RUNTIME_TYPE,
				data: { snapshot: snapshotA },
			},
			{
				type: "custom",
				customType: RLM_RUNTIME_TYPE,
				data: { snapshot: snapshotB },
			},
		]);

		expect(findLatestSnapshot(ctx)).toEqual(snapshotB);
	});

	it("returns undefined when no snapshots exist", () => {
		const ctx = makeCtx("session-1", [
			{
				type: "message",
				message: { role: "toolResult", toolName: "read", details: {} },
			},
		]);

		expect(findLatestSnapshot(ctx)).toBeUndefined();
	});

	it("supports branch-level snapshot and workspace lookup", () => {
		const branch = [
			{ type: "custom", customType: RLM_RUNTIME_TYPE, data: { snapshot: snapshotA } },
			{ type: "custom", customType: RLM_WORKSPACE_TYPE, data: { workspace: { goal: "a" } } },
			{ type: "custom", customType: RLM_RUNTIME_TYPE, data: { snapshot: snapshotB } },
		];

		expect(findLatestSnapshotInBranch(branch)).toEqual(snapshotB);
		expect(findLatestWorkspaceInBranch(branch)).toEqual({ goal: "a" });
	});

	it("finds the latest persisted workspace entry", () => {
		const workspace = { goal: "refactor", plan: ["a", "b"] };
		const ctx = makeCtx("session-1", [
			{
				type: "custom",
				customType: RLM_WORKSPACE_TYPE,
				data: { workspace: { old: true } },
			},
			{
				type: "custom",
				customType: RLM_WORKSPACE_TYPE,
				data: { workspace },
			},
		]);

		expect(findLatestWorkspace(ctx)).toEqual(workspace);
	});

	it("returns null when the latest workspace entry clears persisted workspace", () => {
		const ctx = makeCtx("session-1", [
			{
				type: "custom",
				customType: RLM_WORKSPACE_TYPE,
				data: { workspace: { old: true } },
			},
			{
				type: "custom",
				customType: RLM_WORKSPACE_TYPE,
				data: { workspace: null },
			},
		]);

		expect(findLatestWorkspace(ctx)).toBeNull();
	});

	it("returns undefined when no workspace entry exists", () => {
		expect(findLatestWorkspace(makeCtx("session-1", []))).toBeUndefined();
	});

	it("overlays workspace into the restored runtime snapshot", () => {
		const snapshot: RuntimeSnapshot = {
			version: 1,
			bindings: { answer: 42, workspace: { old: true } },
			entries: [],
		};
		const workspace = { goal: "refactor", plan: ["a", "b"] };

		expect(composeRuntimeSnapshot(snapshot, workspace)).toEqual({
			version: 1,
			bindings: {
				answer: 42,
				workspace,
			},
			entries: [],
		});
	});

	it("clears workspace from the restored runtime snapshot when explicitly reset", () => {
		const snapshot: RuntimeSnapshot = {
			version: 1,
			bindings: { answer: 42, workspace: { old: true } },
			entries: [],
		};

		expect(composeRuntimeSnapshot(snapshot, null)).toEqual({
			version: 1,
			bindings: { answer: 42 },
			entries: [],
		});
	});

	it("builds a bootstrap snapshot from the latest child bootstrap entry", () => {
		const state = { files: ["a.ts", "b.ts"], summary: "auth" };
		const ctx = makeCtx("session-1", [
			{
				type: "custom",
				customType: "rlm-child-bootstrap",
				data: { state: { old: true } },
			},
			{
				type: "custom",
				customType: "rlm-child-bootstrap",
				data: { state },
			},
		]);

		expect(findBootstrapSnapshot(ctx)).toEqual({
			version: 1,
			bindings: {
				input: state,
				parentState: state,
			},
			entries: [],
		});
	});

	it("returns undefined when no child bootstrap entry exists", () => {
		const ctx = makeCtx("session-1", []);
		expect(findBootstrapSnapshot(ctx)).toBeUndefined();
	});

	it("builds a child handoff from the latest child branch state", () => {
		const branch = [
			{ type: "custom", customType: RLM_RUNTIME_TYPE, data: { snapshot: snapshotA } },
			{ type: "custom", customType: RLM_WORKSPACE_TYPE, data: { workspace: { goal: "refactor", done: ["scan"] } } },
			{ type: "message", message: { role: "toolResult", toolName: "rlm_exec", details: { snapshot: snapshotB } } },
		];

		expect(
			buildChildHandoffFromBranch(branch, {
				childId: "child-1",
				role: "worker",
				depth: 1,
				turns: 4,
				reason: "budget_exhausted",
				summary: "Scanned target files",
				suggestedNextPrompt: "Continue from checkpoint",
			}),
		).toEqual({
			version: 1,
			childId: "child-1",
			role: "worker",
			depth: 1,
			turns: 4,
			reason: "budget_exhausted",
			snapshot: snapshotB,
			workspace: { goal: "refactor", done: ["scan"] },
			summary: "Scanned target files",
			suggestedNextPrompt: "Continue from checkpoint",
		});
	});
});
