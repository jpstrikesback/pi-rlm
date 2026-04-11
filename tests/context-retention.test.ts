import { describe, expect, it } from "vitest";
import { applyRetentionPolicy, buildRetentionCompactionSummary } from "../src/context-retention.js";
import { ensureWorkspaceShape } from "../src/workspace.js";

function makeMessage(role: string, extra: Record<string, unknown> = {}, timestamp = Date.now()) {
	return {
		role,
		timestamp,
		...extra,
	} as any;
}

describe("applyRetentionPolicy", () => {
	it("injects metadata-first externalized context in no-subcalls mode", () => {
		const result = applyRetentionPolicy(
			[
				makeMessage("user", { content: "Turn 1" }, 1),
				makeMessage("assistant", { content: [{ type: "text", text: "A1" }] }, 2),
				makeMessage("user", { content: "Turn 2" }, 3),
			],
			{
				workspace: ensureWorkspaceShape({
					goal: "refactor",
					files: ["src/a.ts"],
					findings: ["auth shared"],
					meta: { version: 1, coordination: { hasCommitted: true, pendingConsolidation: false } },
				}),
				externalizationKernel: "no-subcalls",
				currentTurnIndex: 1,
			},
		);

		expect(result.messages[0].role).toBe("user");
		expect((result.messages[0] as any).content).toContain("deterministic compiled working set from externalized state");
		expect((result.messages[0] as any).content).toContain("Active context:");
		expect((result.messages[0] as any).content).toContain("Workspace manifest handles:");
		expect(result.metrics.prunedTurns).toBeGreaterThan(0);
	});

	it("drops older successful transcript/tool payloads and keeps compiled context plus the latest turn", () => {
		const result = applyRetentionPolicy(
			[
				makeMessage("user", { content: "Turn 1" }, 1),
				makeMessage("assistant", { content: [{ type: "text", text: "Need to inspect files" }] }, 2),
				makeMessage("toolResult", { toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "very large file contents" }], isError: false }, 3),
				makeMessage("user", { content: "Turn 2" }, 4),
				makeMessage("assistant", { content: [{ type: "text", text: "Need one more check" }] }, 5),
				makeMessage("toolResult", { toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: "current turn output" }], isError: false }, 6),
				makeMessage("user", { content: "Turn 3" }, 7),
			],
			{
				workspace: ensureWorkspaceShape({ goal: "refactor" }),
				externalizationKernel: "current",
			},
		);

		expect(typeof (result.messages[0] as any).content).toBe("string");
		expect((result.messages[0] as any).content).toContain("deterministic compiled working set");
		expect(JSON.stringify(result.messages)).not.toContain("very large file contents");
		expect(JSON.stringify(result.messages)).not.toContain("Need to inspect files");
		expect(JSON.stringify(result.messages)).toContain("Turn 3");
		expect(result.metrics.prunedTurns).toBeGreaterThan(0);
	});
});

describe("buildRetentionCompactionSummary", () => {
	it("describes compaction in terms of durable workspace state", () => {
		const summary = buildRetentionCompactionSummary(
			ensureWorkspaceShape({ goal: "refactor", files: ["src/a.ts"] }),
			{
				messagesToSummarize: [makeMessage("assistant", { content: [{ type: "text", text: "A1" }] }, 1)],
				turnPrefixMessages: [makeMessage("user", { content: "Turn 2" }, 2)],
				previousSummary: "older summary",
				tokensBefore: 123,
				firstKeptEntryId: "entry-2",
			},
		);

		expect(summary).toContain("RLM context compacted into durable workspace state.");
		expect(summary).toContain("Working set:");
		expect(summary).toContain("Pointers:");
	});
});
