import { describe, expect, it } from "vitest";
import { collectRlmSessionStats } from "../src/stats.js";
import type { RuntimeSnapshot } from "../src/types.js";

function makeCtx(branch: unknown[]) {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as any;
}

const snapshot: RuntimeSnapshot = {
	version: 1,
	bindings: { answer: 42, files: ["a.ts"] },
	entries: [
		{ name: "answer", type: "number", restorable: true, preview: "42" },
		{ name: "files", type: "array", restorable: true, preview: '["a.ts"]' },
	],
};

describe("collectRlmSessionStats", () => {
	it("collects prompt mode, exec counts, child stats, var counts, and leaf tool counts", () => {
		const ctx = makeCtx([
			{ type: "custom", customType: "rlm-mode", data: { enabled: true } },
			{ type: "custom", customType: "rlm-prompt-mode", data: { mode: "coordinator" } },
			{ type: "message", message: { role: "toolResult", toolName: "read", details: {} } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "rlm_exec",
					details: {
						snapshot,
						childQueryCount: 2,
						childTurns: 5,
					},
				},
			},
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
		]);

		expect(collectRlmSessionStats(ctx, { depth: 0, maxDepth: 2 })).toEqual({
			enabled: true,
			promptMode: "coordinator",
			depth: 0,
			maxDepth: 2,
			execCount: 1,
			childQueryCount: 2,
			childTurns: 5,
			runtimeVarCount: 2,
			activeContextRefCount: 0,
			leafToolCount: 2,
		});
	});

	it("falls back to defaults when no RLM state exists", () => {
		const ctx = makeCtx([]);

		expect(collectRlmSessionStats(ctx, { depth: 1, maxDepth: 3 })).toEqual({
			enabled: false,
			promptMode: "balanced",
			depth: 1,
			maxDepth: 3,
			execCount: 0,
			childQueryCount: 0,
			childTurns: 0,
			runtimeVarCount: 0,
			activeContextRefCount: 0,
			leafToolCount: 0,
		});
	});

	it("prefers the live runtime snapshot when provided", () => {
		const ctx = makeCtx([
			{ type: "custom", customType: "rlm-mode", data: { enabled: true } },
			{ type: "custom", customType: "rlm-prompt-mode", data: { mode: "aggressive" } },
		]);
		const liveSnapshot: RuntimeSnapshot = {
			version: 1,
			bindings: { x: 1 },
			entries: [{ name: "x", type: "number", restorable: true, preview: "1" }],
		};

		expect(collectRlmSessionStats(ctx, { depth: 0, maxDepth: 2 }, liveSnapshot).runtimeVarCount).toBe(1);
	});
});
