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
	it("prunes older turns, removes legacy hidden context, and inserts a thin placeholder", () => {
		const result = applyRetentionPolicy(
			[
				makeMessage("compactionSummary", { summary: "older summary" }, 1),
				makeMessage("user", { content: "Turn 1" }, 2),
				makeMessage("assistant", { content: [{ type: "text", text: "A1" }] }, 3),
				makeMessage("toolResult", { toolName: "rlm_exec", content: [{ type: "text", text: "ok" }], details: {}, isError: false }, 4),
				makeMessage("user", { content: "Turn 2" }, 5),
				makeMessage("assistant", { content: [{ type: "text", text: "A2" }] }, 6),
				makeMessage("user", { content: "Turn 3" }, 7),
				makeMessage("assistant", { content: [{ type: "text", text: "A3" }] }, 8),
				makeMessage("custom", { customType: "rlm-context", content: "legacy hidden context", display: false }, 9),
			],
			{
				workspace: {
					goal: "refactor",
					files: ["src/a.ts"],
				},
				policy: {
					keepRecentToolTurns: 0,
					keepRecentUserTurns: 2,
					keepRecentAssistantTurns: 1,
					keepLatestSurfaceSummary: true,
				},
			},
		);

		expect(result.metrics.version).toBe(1);
		expect(result.metrics.keptMessages).toBe(result.messages.length);
		expect(result.metrics.prunedMessages).toBeGreaterThan(0);
		expect(result.metrics.placeholderMessages).toBe(1);
		expect(result.metrics.retainedTurns).toBe(2);
		expect(result.metrics.prunedTurns).toBe(1);
		expect(result.metrics.activeContextSummary).toEqual(expect.stringContaining("Goal: refactor"));
		expect(result.messages[0].role).toBe("compactionSummary");
		expect(result.messages[1].role).toBe("user");
		expect((result.messages[1] as any).content).toContain("globalThis.workspace.activeContext");
		expect(result.messages.some((message: any) => message.role === "custom" && message.customType === "rlm-context")).toBe(false);
		expect(result.messages.some((message) => message.role === "user" && typeof (message as any).content === "string" && (message as any).content.includes("Turn 1"))).toBe(false);
		expect(result.messages.some((message) => message.role === "user" && typeof (message as any).content === "string" && (message as any).content.includes("Turn 3"))).toBe(true);
	});

	it("replaces consolidated successful tool outputs with thin placeholders", () => {
		const result = applyRetentionPolicy(
			[
				makeMessage("user", { content: "Turn 1" }, 1),
				makeMessage("assistant", { content: [{ type: "text", text: "Need to inspect files" }] }, 2),
				makeMessage(
					"toolResult",
					{
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "very large file contents" }],
						isError: false,
					},
					3,
				),
				makeMessage("user", { content: "Turn 2" }, 4),
			],
			{
				currentTurnIndex: 1,
				workspace: ensureWorkspaceShape({
					retention: {
						leases: [
							{
								id: "tool:read:1",
								source: "tool",
								sourceName: "read",
								turnIndex: 0,
								messageFingerprint: "ca4a9bbe28fa",
								status: "consolidated",
								consolidatedTo: [{ kind: "workspace-path", ref: "globalThis.workspace.activeContext" }],
								createdAt: "2026-01-01T00:00:00.000Z",
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						],
					},
				}),
			},
		);

		const toolMessage = result.messages.find((message: any) => message.role === "toolResult") as any;
		expect(toolMessage.content[0].text).toContain("read output consolidated");
		expect(toolMessage.content[0].text).toContain("globalThis.workspace.activeContext");
	});

	it("builds a compact summary from the current workspace and previous compaction state", () => {
		const summary = buildRetentionCompactionSummary(
			ensureWorkspaceShape({ goal: "refactor", plan: ["scan", "rewrite"], files: ["src/a.ts"] }),
			{
				messagesToSummarize: [makeMessage("user", { content: "Turn 1" }, 2)],
				turnPrefixMessages: [makeMessage("assistant", { content: [{ type: "text", text: "keep" }] }, 3)],
				previousSummary: "previous compacted summary that should be trimmed down",
				tokensBefore: 42,
				firstKeptEntryId: "entry-42",
			},
		);

		expect(summary).toContain("RLM context compacted into durable workspace state.");
		expect(summary).toContain("Summarized messages: 1");
		expect(summary).toContain("Kept turn prefix messages: 1");
		expect(summary).toContain("Working set:");
		expect(summary).toContain("Goal: refactor");
		expect(summary).toContain("Inspect globalThis.workspace.activeContext first.");
		expect(summary).toContain("Previous compaction summary:");
		expect(summary).toContain("previous compacted summary");
	});
});
