import { describe, expect, it } from "vitest";
import type { RlmChildArtifact } from "../src/types.js";
import {
	attachInternalLlmQueryContext,
	buildStateManifest,
	buildWorkspaceManifest,
	ensureWorkspaceShape,
	recordArtifact,
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
		const workspace = ensureWorkspaceShape({ goal: "refactor" });

		expect(workspace.goal).toBe("refactor");
		expect(workspace.childArtifacts).toEqual([]);
		expect(workspace.childArtifactSummaries).toEqual([]);
		expect(workspace.artifactIndex?.recentIds).toEqual([]);
		expect(workspace.meta?.version).toBe(1);
	});

	it("records artifacts and rebuilds artifact indexes", () => {
		const workspace = ensureWorkspaceShape({ goal: "refactor" });
		recordArtifact(workspace, makeArtifact({ id: "child-1", files: ["src/auth.ts"], tags: ["auth"] }));
		recordArtifact(workspace, makeArtifact({ id: "child-2", summary: "plan routing", files: ["src/router.ts"], tags: ["routing"] }));

		expect(workspace.childArtifacts).toHaveLength(2);
		expect(workspace.lastChildArtifact?.id).toBe("child-2");
		expect(workspace.childArtifactSummaries?.map((item) => item.id)).toEqual(["child-1", "child-2"]);
		expect(workspace.artifactIndex?.recentIds).toEqual(["child-1", "child-2"]);
		expect(workspace.artifactIndex?.byTag?.auth).toEqual(["child-1"]);
		expect(workspace.artifactIndex?.byFile?.["src/router.ts"]).toEqual(["child-2"]);
	});

	it("builds manifests for parent state and workspace metadata", () => {
		const workspace = ensureWorkspaceShape({
			goal: "refactor",
			files: ["src/a.ts", "src/b.ts", "src/c.ts"],
			findings: ["auth is shared"],
		});
		recordArtifact(workspace, makeArtifact({ id: "child-9", summary: "auth summary", tags: ["auth"] }));

		const stateManifest = buildStateManifest({ files: ["a.ts", "b.ts"], target: "auth" });
		const workspaceManifest = buildWorkspaceManifest(workspace, { relevantArtifacts: selectRelevantArtifacts(workspace, { prompt: "inspect auth", role: "scout" }) });

		expect(stateManifest?.path).toBe("globalThis.parentState");
		expect(stateManifest?.type).toBe("object");
		expect(workspaceManifest?.runtime.workspacePath).toBe("globalThis.workspace");
		expect(workspaceManifest?.artifactCount).toBe(1);
		expect(workspaceManifest?.sections.files?.type).toBe("array");
		expect(workspaceManifest?.relevantArtifacts?.[0]?.id).toBe("child-9");
	});

	it("attaches and extracts hidden llmQuery runtime context without changing the public input shape", () => {
		const original = { prompt: "scan auth", state: { files: ["src/auth.ts"] } };
		const attached = attachInternalLlmQueryContext(original, { workspace: ensureWorkspaceShape({ goal: "refactor" }) });
		const { publicInput, workspace } = splitInternalLlmQueryContext(attached);

		expect(publicInput).toEqual(original);
		expect((publicInput as Record<string, unknown>).__rlmRuntimeContext).toBeUndefined();
		expect(workspace?.goal).toBe("refactor");
	});
});
