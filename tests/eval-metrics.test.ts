import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAssistantPathCitations, analyzeCommitTruthfulness, computeRepeatedReadRatio } from "../scripts/eval/metrics.js";

describe("analyzeCommitTruthfulness", () => {
	it("flags explicit commit claims when no actual commit happened", () => {
		const result = analyzeCommitTruthfulness(
			"Done — I committed the reusable findings into globalThis.workspace and finalized from runtime state.",
			0,
		);

		expect(result.claimedCommit).toBe(true);
		expect(result.actualCommit).toBe(false);
		expect(result.falseClaim).toBe(true);
		expect(result.claimSignals.length).toBeGreaterThan(0);
	});

	it("does not flag conceptual mentions of commit as actual claims", () => {
		const result = analyzeCommitTruthfulness(
			"Strongest recommendation: make workspace.commit the mandatory handoff point after leaf-tool bursts.",
			0,
		);

		expect(result.claimedCommit).toBe(false);
		expect(result.falseClaim).toBe(false);
	});
});

describe("computeRepeatedReadRatio", () => {
	it("returns undefined when there are no read paths", () => {
		expect(computeRepeatedReadRatio([])).toBeUndefined();
	});

	it("counts duplicated reads as a ratio of total reads", () => {
		expect(computeRepeatedReadRatio(["src/a.ts", "src/b.ts", "src/a.ts", "src/a.ts"])).toBe(0.5);
	});
});

describe("analyzeAssistantPathCitations", () => {
	const repoRoot = process.cwd();

	it("detects existing and missing local path citations", () => {
		const result = analyzeAssistantPathCitations(
			"Relevant files: src/runtime.ts, README.md, and src/does-not-exist.ts",
			repoRoot,
		);

		expect(result).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ cited: "src/runtime.ts", exists: true, kind: "file" }),
				expect.objectContaining({ cited: "README.md", exists: true, kind: "file" }),
				expect.objectContaining({ cited: "src/does-not-exist.ts", exists: false }),
			]),
		);
	});

	it("ignores obvious non-path tokens like model selectors and globals", () => {
		const result = analyzeAssistantPathCitations(
			"Use openai/gpt-5.4-mini, inspect globalThis.workspace, and check src/workspace.ts",
			repoRoot,
		);

		expect(result.some((citation) => citation.cited === "openai/gpt-5.4-mini")).toBe(false);
		expect(result.some((citation) => citation.cited === "globalThis.workspace")).toBe(false);
		expect(result.some((citation) => citation.cited === "src/workspace.ts")).toBe(true);
	});

	it("resolves relative citations against the repo root", () => {
		const result = analyzeAssistantPathCitations("Check scripts/eval.ts", repoRoot);
		const citation = result.find((item) => item.cited === "scripts/eval.ts");

		expect(citation?.resolvedPath).toBe(path.resolve(repoRoot, "scripts/eval.ts"));
		expect(citation?.exists).toBe(true);
	});
});
