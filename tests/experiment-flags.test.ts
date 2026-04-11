import { describe, expect, it } from "vitest";
import { buildExecPromptGuidelines, buildRoutingFewShotBlock, buildRoutingLadderBlock } from "../src/experiment-flags.js";

describe("experiment flags routing guidance", () => {
	it("builds the routing ladder for normal mode", () => {
		const block = buildRoutingLadderBlock();
		expect(block).toContain("Routing ladder:");
		expect(block).toContain("Direct Pi tools first for simple grounded work");
		expect(block).toContain("Use rlm_exec when the task needs durable state");
		expect(block).toContain("use llm_query for bounded lightweight side-computation and rlm_query for deeper decomposable subproblems");
	});

	it("builds few-shot routing examples for normal mode", () => {
		const block = buildRoutingFewShotBlock();
		expect(block).toContain("Few-shot routing examples:");
		expect(block).toContain("Do: if the task explicitly asks for llm_query or rlm_query");
		expect(block).toContain("Do not replace explicitly requested llm_query/rlm_query work with manual repo scanning");
		expect(block).toContain("Do not add fs imports, file writes, or .local artifacts inside rlm_exec");
		expect(block).toContain("If optional runtime code fails, remove it and continue with the core task path.");
	});

	it("includes routing ladder and few-shots in exec guidelines", () => {
		const guidelines = buildExecPromptGuidelines({});
		expect(guidelines.some((line) => line.includes("Routing ladder:"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Few-shot routing examples:"))).toBe(true);
	});

	it("adapts the ladder for no-subcalls mode", () => {
		const block = buildRoutingLadderBlock({ externalizationKernel: "no-subcalls" });
		expect(block).toContain("child-query helpers are disabled");
		expect(block).not.toContain("llm_query for bounded lightweight side-computation");
	});
});
