import { describe, expect, it } from "vitest";
import { buildForcedFinalizePrompt, parseModelSelector, selectRequestedChildModel } from "../src/recursion.js";

function makeArtifact() {
	return {
		version: 1,
		id: "child-1",
		childId: "child-1",
		kind: "child-query",
		role: "scout",
		depth: 1,
		turns: 3,
		status: "budget_exhausted",
		prompt: "scan auth",
		answer: "done",
		summary: "auth summary",
		state: { files: ["src/auth.ts"], findings: ["shared"] },
		workspace: {
			goal: "refactor",
			plan: ["scan", "rewrite"],
			files: ["src/auth.ts"],
			findings: ["shared auth"],
			childArtifacts: [
				{
					version: 1,
					id: "child-1",
					childId: "child-1",
					kind: "child-query",
					role: "scout",
					depth: 1,
					turns: 3,
					status: "budget_exhausted",
					prompt: "scan auth",
					answer: "done",
					summary: "auth summary",
					producedAt: "2026-04-04T00:00:00.000Z",
				},
			],
			artifactIndex: { recentIds: ["child-1"] },
			meta: { version: 1, updatedAt: "2026-04-04T00:00:00.000Z" },
		},
	};
}

describe("buildForcedFinalizePrompt", () => {
	it("builds a focused finalize prompt from restored state", () => {
		const prompt = buildForcedFinalizePrompt({
			prompt: "Review the child output",
			artifact: makeArtifact() as any,
			outputMode: "json",
			schema: { summary: "string" },
		});

		expect(prompt).toContain("You are a recursive RLM child node resuming from previously gathered child state.");
		expect(prompt).toContain("Runtime state access:");
		expect(prompt).toContain("Task snapshot: globalThis.context");
		expect(prompt).toContain("Restored state keys: files, findings");
		expect(prompt).toContain("Return valid JSON only");
		expect(prompt).toContain('"summary": "string"');
		expect(prompt).toContain("Original task:\nReview the child output");
		expect(prompt).not.toContain("Examples:");
	});
});

describe("selectRequestedChildModel", () => {
	it("uses dedicated defaults for each child query mode", () => {
		expect(selectRequestedChildModel(undefined, "simple", "openai-codex/gpt-5.4-nano:off")).toBe("openai-codex/gpt-5.4-nano:off");
		expect(selectRequestedChildModel(undefined, "recursive", "openai-codex/gpt-5.4-nano:off", "openai-codex/gpt-5.4-mini:off")).toBe(
			"openai-codex/gpt-5.4-mini:off",
		);
		expect(selectRequestedChildModel("openai/gpt-5.4-mini", "simple", "openai/gpt-5.4-nano:off")).toBe("openai/gpt-5.4-mini");
	});

	it("keeps explicit per-call model override above profile defaults", () => {
		expect(selectRequestedChildModel("openai-codex/gpt-5.4-mini", "simple", "openai-codex/gpt-5.4-nano:off")).toBe("openai-codex/gpt-5.4-mini");
		expect(
			selectRequestedChildModel("openai-codex/gpt-5.4-mini:off", "recursive", "openai-codex/gpt-5.4-nano:off", "openai-codex/gpt-5.4-class"),
		).toBe("openai-codex/gpt-5.4-mini:off");
	});
});

describe("parseModelSelector", () => {
	it("parses an exact provider/id selector with thinking suffix", () => {
		expect(parseModelSelector("openai/gpt-5-mini:off")).toEqual({
			provider: "openai",
			id: "gpt-5-mini",
			thinkingLevel: "off",
		});
	});

	it("rejects malformed selectors", () => {
		expect(() => parseModelSelector("gpt-5-mini")).toThrow(/provider\/id/);
		expect(() => parseModelSelector("openai/gpt-5-mini:turbo")).toThrow(/Unknown thinking level/);
	});
});
