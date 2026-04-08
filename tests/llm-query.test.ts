import { describe, expect, it } from "vitest";
import { buildChildPrompt, normalizeLlmQueryInput, parseChildResult } from "../src/llm-query.js";

describe("llmQuery normalization", () => {
	it("applies defaults for the minimal request shape", () => {
		const normalized = normalizeLlmQueryInput({ prompt: "Analyze auth" });

		expect(normalized).toEqual({
			prompt: "Analyze auth",
			role: "general",
			tools: "read-only",
			budget: { maxDepth: 2, maxTurns: 5 },
			output: { mode: "text" },
		});
	});

	it("rejects a missing or empty prompt", () => {
		expect(() => normalizeLlmQueryInput({ prompt: "" })).toThrow(/non-empty prompt/);
		expect(() => normalizeLlmQueryInput({} as any)).toThrow(/non-empty prompt/);
	});

	it("rejects non structured-cloneable state", () => {
		expect(() =>
			normalizeLlmQueryInput({
				prompt: "Analyze auth",
				state: { fn: () => 1 } as any,
			}),
		).toThrow(/structured-cloneable/);
	});

});

describe("buildChildPrompt", () => {
	it("keeps the active working set and task ordering compact", () => {
		const prompt = buildChildPrompt(
			normalizeLlmQueryInput({
				prompt: "Summarize these files",
				role: "scout",
				state: { files: ["a.ts", "b.ts"], findings: { auth: true } },
				budget: { maxTurns: 3 },
				output: { mode: "json", schema: { summary: "string" } },
			}),
			{
				workspace: {
					goal: "refactor",
					files: ["src/a.ts", "src/b.ts"],
					findings: ["auth shared"],
					childArtifacts: [
						{
							version: 1,
							id: "child-1",
							childId: "child-1",
							kind: "child-query",
							role: "scout",
							depth: 1,
							turns: 2,
							status: "ok",
							prompt: "scan auth",
							answer: "done",
							summary: "auth summary",
							files: ["src/auth.ts"],
							tags: ["auth"],
							producedAt: "2026-04-04T00:00:00.000Z",
						},
					],
				},
			},
		);

		expect(prompt).toContain("Role: scout");
		expect(prompt).toContain("Runtime state access:");
		expect(prompt).toContain("Inspect globalThis.workspace.activeContext first.");
		expect(prompt).toContain("Active working set:");
		expect(prompt).toContain("Goal: refactor");
		expect(prompt).toContain("Files: src/a.ts, src/b.ts");
		expect(prompt).toContain("Parent state keys: files, findings");
		expect(prompt).toContain("Return valid JSON only");
		expect(prompt).toContain('"summary": "string"');
		expect(prompt).toContain("Task:\nSummarize these files");
		expect(prompt.indexOf("Active working set:")).toBeLessThan(prompt.indexOf("Task:\nSummarize these files"));
		expect(prompt.indexOf("Parent state keys:")).toBeLessThan(prompt.indexOf("Task:\nSummarize these files"));
	});
});

describe("parseChildResult", () => {
	it("returns trimmed text in text mode", () => {
		const input = normalizeLlmQueryInput({ prompt: "hello" });
		const result = parseChildResult("  final answer  ", input, 2);

		expect(result).toEqual({
			ok: true,
			answer: "final answer",
			summary: "final answer",
			role: "general",
			usage: { turns: 2 },
		});
	});

	it("returns a stable failure for empty text mode output", () => {
		const input = normalizeLlmQueryInput({ prompt: "hello" });
		const result = parseChildResult("   ", input, 1);

		expect(result).toEqual({
			ok: false,
			answer: "",
			role: "general",
			usage: { turns: 1 },
			error: "Child returned empty output",
		});
	});

	it("parses raw json in json mode", () => {
		const input = normalizeLlmQueryInput({
			prompt: "hello",
			output: { mode: "json" },
		});
		const result = parseChildResult('{"summary":"ok","value":42}', input, 1);

		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ summary: "ok", value: 42 });
		expect(result.summary).toBe("ok");
	});

	it("parses fenced json in json mode", () => {
		const input = normalizeLlmQueryInput({
			prompt: "hello",
			output: { mode: "json" },
		});
		const result = parseChildResult('```json\n{"summary":"ok","value":42}\n```', input, 1);

		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ summary: "ok", value: 42 });
	});

	it("returns a stable parse failure for invalid json", () => {
		const input = normalizeLlmQueryInput({
			prompt: "hello",
			output: { mode: "json" },
		});
		const result = parseChildResult("not json", input, 1);

		expect(result).toEqual({
			ok: false,
			answer: "not json",
			role: "general",
			usage: { turns: 1 },
			error: "Failed to parse JSON child output",
		});
	});
});
