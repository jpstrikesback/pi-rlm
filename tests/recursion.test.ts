import { describe, expect, it } from "vitest";
import { buildForcedFinalizePrompt } from "../src/recursion.js";

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
	it("keeps runtime pointers before the original task and uses the restored working set", () => {
		const prompt = buildForcedFinalizePrompt({
			prompt: "Review the child output",
			artifact: makeArtifact() as any,
			outputMode: "json",
			schema: { summary: "string" },
		});

		expect(prompt).toContain("You are a recursive RLM child node resuming from previously gathered child state.");
		expect(prompt).toContain("Inspect globalThis.workspace.activeContext first.");
		expect(prompt).toContain("Restored working set:");
		expect(prompt).toContain("Goal: refactor");
		expect(prompt).toContain("Current child summary:");
		expect(prompt).toContain("Restored state keys: files, findings");
		expect(prompt).toContain("Return valid JSON only");
		expect(prompt).toContain('"summary": "string"');
		expect(prompt).toContain("Original task:\nReview the child output");
		expect(prompt.indexOf("Restored working set:")).toBeLessThan(prompt.indexOf("Original task:\nReview the child output"));
		expect(prompt.indexOf("Current child summary:")).toBeLessThan(prompt.indexOf("Original task:\nReview the child output"));
	});
});
