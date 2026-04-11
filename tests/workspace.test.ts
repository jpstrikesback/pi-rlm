import { describe, expect, it } from "vitest";
import type { RlmChildArtifact } from "../src/types.js";
import {
	attachInternalLlmQueryContext,
	buildStateManifest,
	buildWorkspaceManifest,
	buildWorkspaceWorkingSetSummary,
	commitWorkspacePatch,
	ensureWorkspaceShape,
	hasCommittedWorkspaceState,
	hasPendingWorkspaceConsolidation,
	recordArtifact,
	recordCommitEvidence,
	recordRetentionLease,
	recordRetentionMetrics,
	recordToolEvidence,
	shouldUseCommittedRetentionPolicy,
	selectRelevantArtifacts,
	splitInternalLlmQueryContext,
} from "../src/workspace.js";

function makeArtifact(overrides: Partial<RlmChildArtifact> = {}): RlmChildArtifact {
	return {
		version: 1,
		id: overrides.id ?? "child-1",
		childId: overrides.childId ?? overrides.id ?? "child-1",
		kind: "child-query",
		role: overrides.role ?? "scout",
		depth: overrides.depth ?? 1,
		turns: overrides.turns ?? 2,
		status: overrides.status ?? "ok",
		prompt: overrides.prompt ?? "scan auth",
		answer: overrides.answer ?? "done",
		summary: overrides.summary ?? "auth summary",
		data: overrides.data,
		error: overrides.error,
		state: overrides.state,
		files: overrides.files,
		tags: overrides.tags,
		producedAt: overrides.producedAt ?? "2026-04-04T00:00:00.000Z",
		workspace: overrides.workspace,
		snapshot: overrides.snapshot,
	};
}

describe("workspace helpers", () => {
	it("normalizes an arbitrary workspace object into the shared shape", () => {
		const workspace = ensureWorkspaceShape({ goal: "refactor", files: ["src/a.ts"] });
		expect(workspace.goal).toBe("refactor");
		expect(workspace.childArtifacts).toEqual([]);
		expect(workspace.childArtifactSummaries).toEqual([]);
		expect(workspace.artifactIndex?.recentIds).toEqual([]);
		expect(workspace.activeContext?.goal).toBe("refactor");
		expect(workspace.activeContext?.relevantFiles).toEqual(["src/a.ts"]);
		expect(buildWorkspaceWorkingSetSummary(workspace)).toContain("Goal: refactor");
	});

	it("records artifacts and rebuilds artifact indexes", () => {
		const workspace = ensureWorkspaceShape({ goal: "refactor" });
		recordArtifact(workspace, makeArtifact({ id: "child-1", files: ["src/auth.ts"], tags: ["auth"] }));
		recordArtifact(workspace, makeArtifact({ id: "child-2", summary: "plan routing", files: ["src/router.ts"], tags: ["routing"] }));
		expect(workspace.childArtifacts).toHaveLength(2);
		expect(workspace.artifactIndex?.recentIds).toEqual(["child-1", "child-2"]);
		expect(selectRelevantArtifacts(workspace, { prompt: "auth", role: "scout", limit: 1 })[0]?.id).toBe("child-1");
	});

	it("commits durable workspace patches and updates coordination metadata", () => {
		const { workspace, result } = commitWorkspacePatch(
			ensureWorkspaceShape({ goal: "audit", files: ["src/a.ts"] }),
			{
				goal: "refactor auth",
				plan: ["inspect", "patch"],
				files: ["src/a.ts", "src/b.ts"],
				findings: ["auth state leaks"],
				openQuestions: ["Need migration?"],
				partialOutputs: { draft: { status: "ready" } },
				ignored: true,
			},
			{ turnIndex: 4, now: "2026-04-08T00:00:00.000Z" },
		);

		expect(result).toEqual(expect.objectContaining({
			ok: true,
			planLength: 2,
			findingCount: 1,
			pendingConsolidation: false,
		}));
		expect(workspace.meta?.coordination).toEqual(expect.objectContaining({
			hasCommitted: true,
			pendingConsolidation: false,
			lastCommittedTurn: 4,
		}));
		expect(hasCommittedWorkspaceState(workspace)).toBe(true);
		expect(hasPendingWorkspaceConsolidation(workspace)).toBe(false);
		expect(shouldUseCommittedRetentionPolicy(workspace)).toBe(true);
	});

	it("records pending tool evidence and clears it when commit evidence is recorded", () => {
		const workspace = ensureWorkspaceShape({ goal: "refactor", files: ["src/a.ts"] });
		const withTool = recordToolEvidence(workspace, {
			turnIndex: 2,
			toolName: "read",
			args: { path: "src/context-retention.ts" },
			result: { content: [{ type: "text", text: "src/context-retention.ts" }] },
			now: "2026-04-09T00:00:00.000Z",
		});
		expect(withTool?.evidence?.pendingIds).toHaveLength(1);

		const withCommit = recordCommitEvidence(withTool, {
			turnIndex: 2,
			changedKeys: ["findings", "files"],
			now: "2026-04-09T00:00:01.000Z",
		});
		expect(withCommit?.evidence?.pendingIds).toEqual([]);
		expect(withCommit?.evidence?.checkpoints?.length).toBeGreaterThan(0);
		expect(hasPendingWorkspaceConsolidation(withCommit)).toBe(false);
	});

	it("records retention metadata on the durable workspace", () => {
		const workspace = ensureWorkspaceShape({ goal: "refactor", files: ["src/a.ts"] });
		const retention = {
			version: 1,
			keptMessages: 4,
			prunedMessages: 2,
			placeholderMessages: 1,
			retainedTurns: 2,
			prunedTurns: 1,
			activeContextSummary: "Goal: refactor",
		} as const;
		const withLease = recordRetentionLease(workspace, {
			source: "assistant",
			sourceName: "assistant",
			turnIndex: 2,
			messageFingerprint: "assistant:2:preview",
			expiresAfterTurns: 2,
		});
		const next = recordRetentionMetrics(withLease, retention, 3, {
			expireConsolidatedAfterTurns: 2,
			keepLatestSurfaceSummary: true,
		});
		expect(next?.retention?.latestTurnIndex).toBe(3);
		expect(next?.retention?.latestSurfaceSummary).toBe("Goal: refactor");
	});

	it("builds manifests and preserves internal llm query context", () => {
		const workspace = ensureWorkspaceShape({ goal: "refactor", files: ["src/a.ts"], findings: ["one"] });
		const manifest = buildWorkspaceManifest(workspace, { sectionKeys: ["goal", "files"] });
		expect(Object.keys(manifest?.sections ?? {})).toEqual(["goal", "files"]);
		expect(buildStateManifest({ auth: true, count: 1 })).toEqual(
			expect.objectContaining({
				path: "globalThis.parentState",
				type: "object",
				keys: ["auth", "count"],
			}),
		);

		const attached = attachInternalLlmQueryContext({ prompt: "scan" }, { workspace, queryMode: "recursive" });
		const split = splitInternalLlmQueryContext(attached as any);
		expect(split.queryMode).toBe("recursive");
		expect((split.workspace as any)?.goal).toBe("refactor");
	});
});
