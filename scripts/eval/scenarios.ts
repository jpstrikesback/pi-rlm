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

function buildLongHorizonContextTurns() {
	const title = "Audit whether this RLM extension achieves thin live context over a long, multi-turn workflow.";
	const steps = [
		{
			id: "map-root-child-finalize",
			title: "Map root, child, and finalize prompt paths",
			request:
				"Inspect the code paths for root prompts, child prompts, finalization prompts, and runtime restoration. Save concrete findings in runtime for reuse.",
		},
		{
			id: "map-tool-surfaces",
			title: "Map model-visible tool surfaces",
			request:
				"Using the findings already stored, identify which tool outputs are model-visible versus hidden in details/UI. Add exact file paths and the highest-risk surfaces.",
		},
		{
			id: "map-retention-hooks",
			title: "Map retention hooks and policies",
			request:
				"Trace the retention pipeline across context hooks, retention entries, leases, and compaction hooks. Reuse prior notes instead of starting over.",
		},
		{
			id: "map-active-context",
			title: "Map activeContext and workspace projection",
			request:
				"Explain how workspace.activeContext is derived, refreshed, and used in prompts. Focus on what should replace transcript memory.",
		},
		{
			id: "audit-pointer-prompts",
			title: "Audit pointer-based prompt design",
			request:
				"Review child/finalize prompt construction and judge how pointer-based it really is. Note where prose summaries still leak back into prompt context.",
		},
		{
			id: "audit-compaction-bridge",
			title: "Audit compaction bridge",
			request:
				"Inspect how compaction summaries and retention state interact. Summarize whether compaction is reinforcing external memory or merely summarizing a still-growing transcript.",
		},
		{
			id: "find-context-bloat-causes",
			title: "Identify likely context bloat causes",
			request:
				"From the stored findings, list the top concrete reasons context can still balloon across turns. Rank them by likely impact.",
		},
		{
			id: "propose-aggressive-policy",
			title: "Propose a much harsher retention policy",
			request:
				"Design a stricter retention policy that aims for a lean working set. Keep it grounded in the existing code rather than inventing a new architecture.",
		},
		{
			id: "stress-unresolved-flows",
			title: "Stress unresolved tool-flow handling",
			request:
				"Analyze whether unresolved tool flows really survive while ordinary assistant/tool chatter expires. Reuse the previous policy analysis.",
		},
		{
			id: "stress-lease-model",
			title: "Stress-test the lease model",
			request:
				"Evaluate whether leases are doing true consolidation-aware expiration or just bookkeeping. Be explicit about what is missing.",
		},
		{
			id: "compare-transcript-vs-workspace",
			title: "Compare transcript memory versus workspace memory",
			request:
				"Answer whether durable knowledge is mostly living in the workspace yet, or whether the transcript still carries too much of the semantic load.",
		},
		{
			id: "revisit-earlier-findings",
			title: "Revisit earlier findings without re-discovery",
			request:
				"Using only the runtime/workspace notes you already stored unless validation is necessary, restate the strongest evidence for and against real context thinning.",
		},
		{
			id: "narrow-critical-files",
			title: "Narrow to the critical files",
			request:
				"Reduce the problem to the smallest set of source files that actually control long-horizon context shape. Keep the list tight and justified.",
		},
		{
			id: "define-next-implementation-slice",
			title: "Define the next implementation slice",
			request:
				"Propose the smallest implementation slice that would most likely shrink live context in a measurable way over many turns.",
		},
		{
			id: "define-telemetry-checks",
			title: "Define telemetry checks",
			request:
				"Define the exact telemetry checks needed to prove the working set plateaus instead of growing. Reuse existing eval/pi-spy knowledge.",
		},
		{
			id: "define-pass-fail-criteria",
			title: "Define pass/fail criteria",
			request:
				"Write concrete pass/fail criteria for a real RLM context-management win in this repo, not just a cache win.",
		},
		{
			id: "challenge-own-plan",
			title: "Challenge the proposed direction",
			request:
				"Argue against your own proposed next slice. Identify where it could fail to reduce context growth in practice.",
		},
		{
			id: "revise-plan-after-critique",
			title: "Revise the plan after critique",
			request:
				"Revise the next slice after the critique, keeping only the parts most likely to produce thinner live context.",
		},
		{
			id: "final-consolidation",
			title: "Consolidate the long-horizon audit",
			request:
				"Consolidate the most reusable findings, active refs, and recommended next actions into runtime/workspace so they can replace transcript memory.",
		},
		{
			id: "final-verdict",
			title: "Give the final verdict",
			request:
				"Give a final verdict on whether this implementation currently behaves like real RLM context thinning. Keep it evidence-based and grounded in the prior stored notes.",
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
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
			extensionFlags: { "rlm-enabled": true },
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
		{
			id: "rlm-context-long-horizon",
			label: "RLM context long horizon",
			description: "Twenty-turn long-horizon audit meant to reveal whether live context plateaus or keeps growing.",
			cwd: repoRoot,
			corpusSummary: [
				"This RLM extension source",
				"Pi docs/examples for extension lifecycle, context, and compaction",
				"Repeated multi-turn reuse of runtime/workspace findings",
			],
			extensionFlags: { "rlm-enabled": true },
			turns: buildLongHorizonContextTurns(),
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
