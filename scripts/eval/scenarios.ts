import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EvalScenario } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piPackageRoot = path.join(repoRoot, "node_modules", "@mariozechner", "pi-coding-agent");
const piPackageJson = JSON.parse(readFileSync(path.join(piPackageRoot, "package.json"), "utf8")) as {
	version: string;
};

function prelude(title: string): string {
	return [
		`Benchmark task: ${title}`,
		"",
		"Pinned environment:",
		`- Pi version: ${piPackageJson.version}`,
		`- Repo under test: ${repoRoot}`,
		`- Pi package docs/examples root: ${piPackageRoot}`,
		"",
		"Relevant local references:",
		`- ${path.join(piPackageRoot, "README.md")}`,
		`- ${path.join(piPackageRoot, "docs", "extensions.md")}`,
		`- ${path.join(piPackageRoot, "docs", "sdk.md")}`,
		`- ${path.join(piPackageRoot, "examples", "extensions")}`,
		`- ${path.join(piPackageRoot, "examples", "sdk")}`,
		`- ${path.join(repoRoot, "README.md")}`,
		`- ${path.join(repoRoot, "src")}`,
		`- ${path.join(repoRoot, "tests")}`,
		"",
		"Expectations:",
		"- Work like a Pi extension builder using RLM when helpful.",
		"- Reuse runtime/workspace across turns instead of rediscovering the same facts.",
		"- Prefer reading the referenced docs/examples/code rather than guessing.",
		"- Keep conclusions actionable and tied to local file paths.",
		"",
		"Current turn request:",
	].join("\n");
}

export function getEvalScenarios(): EvalScenario[] {
	return [
		{
			id: "extension-research",
			label: "Extension research and runtime reuse",
			description: "Multi-turn Pi extension research task that should reward root runtime reuse without code changes.",
			cwd: repoRoot,
			corpusSummary: [
				"Pi SDK docs and extension examples from node_modules",
				"This repo's README, src/, and tests/",
			],
			turns: [
				{
					id: "map-runtime",
					title: "Map runtime and extension architecture",
					prompt: `${prelude("Map the runtime and extension architecture for Pi + this RLM extension.")}\nCreate a structured architecture map covering runtime persistence, extension hooks, child recursion, and where prompt construction happens. Store reusable findings in runtime.`,
				},
				{
					id: "focus-provider-path",
					title: "Trace provider request path",
					prompt: `${prelude("Trace the provider request path using the findings you already stored.")}\nExplain how a user prompt becomes a provider request, with emphasis on before_agent_start, message conversion, and before_provider_request. Reuse previous runtime notes rather than starting from scratch.`,
				},
				{
					id: "summarize-risks",
					title: "Summarize reusable findings and risks",
					prompt: `${prelude("Summarize the reusable findings and open risks for Pi extension builders.")}\nProduce a concise builder-oriented summary with the most relevant file paths and any open questions that should be validated in code.`,
				},
			],
		},
		{
			id: "extension-build-plan",
			label: "Extension build planning",
			description: "Plan a realistic Pi extension implementation over multiple turns using docs, examples, and runtime notes.",
			cwd: repoRoot,
			corpusSummary: [
				"Pi extension docs/examples",
				"This repo's RLM implementation as a reference extension",
			],
			turns: [
				{
					id: "research-cache-widget",
					title: "Research a cache widget extension",
					prompt: `${prelude("Research how to build a Pi extension that surfaces cache behavior.")}\nResearch the local docs/examples needed to build a Pi extension that shows prompt cache stats in the UI and records prompt-shape diagnostics. Save the most reusable implementation references in runtime.`,
				},
				{
					id: "implementation-plan",
					title: "Produce an implementation plan",
					prompt: `${prelude("Produce a concrete implementation plan for the cache widget extension.")}\nUsing the research already stored in runtime, produce a numbered implementation plan with likely files, hooks, and edge cases. Keep it grounded in actual Pi APIs and examples.`,
				},
				{
					id: "validation-plan",
					title: "Produce a validation plan",
					prompt: `${prelude("Produce the validation strategy for the cache widget extension.")}\nUsing the existing runtime notes, describe how you would test the extension, what benchmark scenarios matter, and which APIs or examples are most relevant for confidence.`,
				},
			],
		},
		{
			id: "rlm-refactor-review",
			label: "RLM refactor review",
			description: "Review and plan a cache-friendly RLM refactor with explicit trade-off analysis.",
			cwd: repoRoot,
			corpusSummary: [
				"This RLM extension source",
				"Pi docs/examples for prompt injection and SDK behavior",
			],
			turns: [
				{
					id: "inspect-current-behavior",
					title: "Inspect current prompt behavior",
					prompt: `${prelude("Inspect the current prompt behavior of this RLM extension.")}\nAnalyze how root prompts, child prompts, and finalization prompts are currently constructed. Save concrete findings in runtime for reuse.`,
				},
				{
					id: "propose-refactor",
					title: "Propose the refactor",
					prompt: `${prelude("Propose a cache-friendly refactor using the prior findings.")}\nPropose a refactor that improves prompt cacheability while preserving RLM behavior. Reuse prior findings and focus on exact files and ordering changes.`,
				},
				{
					id: "review-risks",
					title: "Review risks and evaluation needs",
					prompt: `${prelude("Review the risks and evaluation needs for that refactor.")}\nUsing the prior runtime notes, explain the main risks to root RLM behavior, child recursion quality, and evaluation design. Keep it practical and tied to this repo.`,
				},
			],
		},
	];
}

export function findScenario(id: string): EvalScenario | undefined {
	return getEvalScenarios().find((scenario) => scenario.id === id);
}

export function getRepoRoot(): string {
	return repoRoot;
}

export function getPinnedPiVersion(): string {
	return piPackageJson.version;
}
