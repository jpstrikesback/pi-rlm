import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EvalScenario } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piPackageRoot = path.join(repoRoot, "node_modules", "@mariozechner", "pi-coding-agent");
const piPackageJson = JSON.parse(readFileSync(path.join(piPackageRoot, "package.json"), "utf8")) as {
	version: string;
};

const RLM_EVAL_FLAGS = {
	"rlm-enabled": true,
	"rlm-profile": "openai-5.4-class",
} satisfies Record<string, string | boolean>;

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

function buildCommitDisciplineTurns() {
	const title = "Keep using the RLM workspace as the durable coordinator over repeated leaf-tool bursts.";
	const steps = [
		{
			id: "map-retention-files",
			title: "Map retention files",
			request:
				"Inspect the retention and install paths that control workspace persistence. Store the reusable findings in runtime for the next turns.",
		},
		{
			id: "revisit-without-rediscovery",
			title: "Reuse the prior findings",
			request:
				"Using the findings already stored in runtime, explain the coordination loop across leaf tools, workspace consolidation, and retention. Only re-read code if validation is necessary.",
		},
		{
			id: "focus-leaf-tool-risk",
			title: "Focus the leaf-tool risk",
			request:
				"Identify the main risk when the model uses read/grep/bash/edit tools but does not fold the results back into runtime. Reuse prior notes and keep the answer grounded in exact local files.",
		},
		{
			id: "final-recommendation",
			title: "Consolidate a recommendation",
			request:
				"Consolidate the strongest recommendation for improving durable workspace reuse, using the runtime notes you already stored instead of rediscovering everything.",
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
}

function buildPaperRuntimeSurfaceTurns() {
	const title = "Exercise the paper-style RLM runtime surface on a repo-grounded task.";
	const steps = [
		{
			id: "runtime-surface",
			title: "Use the runtime helper surface",
			request:
				"Start in rlm_exec. Inspect globalThis.context, use llm_query_batched for two small extraction subtasks, use rlm_query for one deeper recursive subproblem, commit the reusable findings into globalThis.workspace, and finalize from runtime state.",
		},
		{
			id: "reuse-buffered-state",
			title: "Reuse the stored buffers",
			request:
				"Reuse the workspace/runtime state you already created. Do not rediscover the same facts unless validation is necessary. Extend the prior findings with one more targeted repo-grounded observation and consolidate again.",
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
}

function buildPaperSubmodelRoutingTurns() {
	const title = "Exercise explicit per-call submodel routing inside RLM child helpers.";
	const steps = [
		{
			id: "submodel-routing",
			title: "Route simple and recursive subcalls through explicit models",
			request:
				"Start in rlm_exec. Use llm_query with model openai/gpt-5.4-mini:off for a lightweight extraction task, then use rlm_query with model openai/gpt-5.4-mini for a deeper repo-grounded subproblem. Commit the result and mention which submodels were used.",
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
}

function buildRecursiveSvgRequirements(extraLines: string[] = []): string {
	return [
		"Draw a scene of turtles eating a pie that is itself made of turtles eating a pie.",
		"Requirements:",
		"- Write the final SVG to {{SVG_OUTPUT_PATH}}.",
		"- SVG size must be exactly 800x800.",
		"- No external assets, no raster images, and no JavaScript.",
		"- Include groups with ids: scene, outer-turtles, pie, inner-scene.",
		"- The outer scene must clearly show at least 3 turtles eating from one pie.",
		"- The pie must visibly contain a smaller scene of turtles eating a pie.",
		"- The inner scene must be recognizable, not just abstract texture.",
		"- Use at most 8 colors.",
		...extraLines,
	].join("\n");
}

function buildPaperRecursiveSvgProofTurns() {
	const title = "Prove recursive helper usage on a fresh recursive SVG task.";
	const steps = [
		{
			id: "recursive-svg-plan",
			title: "Plan the recursive turtle-pie scene",
			request: [
				"Start in rlm_exec.",
				"Design a compact reusable plan for {{SVG_OUTPUT_PATH}} before writing the final file.",
				"Break the work into at least these parts: outer scene, turtle component language, pie/window composition, and inner recursive scene.",
				"Store the reusable plan in runtime/workspace state so later turns can build from it without rediscovering it.",
				"Do not write the final SVG yet.",
				"Keep the answer short and describe only the plan state you stored.",
			].join("\n"),
		},
		{
			id: "recursive-svg-subproblems",
			title: "Solve subproblems with child helpers and store the results",
			request: [
				"Reuse the stored plan; do not start over.",
				"Start in rlm_exec and solve subproblems through child helpers.",
				"Use llm_query for at least two bounded SVG/component subtasks, and use rlm_query for one deeper composition subproblem about making the inner recursive scene legible inside the pie.",
				"If one helper call fails, continue with the remaining required helper calls unless they are actually blocked too.",
				"Store only compact reusable outputs in runtime/workspace state: component decisions, geometry notes, and integration constraints.",
				"Do not write the final SVG yet.",
				"Keep the answer short and mention what was stored for reuse.",
			].join("\n"),
		},
		{
			id: "recursive-svg-compose",
			title: "Compose, inspect, and repair the final recursive SVG",
			request: [
				"Reuse the stored plan and helper results rather than rediscovering them.",
				buildRecursiveSvgRequirements([
					"- After writing the file, inspect it and fix any obvious structural or SVG validity problems.",
					"- Commit the reusable final state into globalThis.workspace.",
					"- Final answer should contain only the file path and a one-line note.",
				]),
			].join("\n"),
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
}

function buildRlmRecursiveSvgNaturalTurns() {
	const title = "Create a fresh recursive SVG artifact and choose the right workflow yourself.";
	const steps = [
		{
			id: "recursive-svg-natural-plan",
			title: "Plan the turtle-pie scene",
			request: [
				"Before writing the base version, think of a cute turtle and a tasty pizza pie that are obviously turtles and pizza pies, and feel alive, fresh, and fun.",
				"Then design a compact reusable plan for {{SVG_OUTPUT_PATH}} that combines those motifs into a recursive scene rather than falling back to a generic default template.",
				"Break the work into sensible parts so later turns can reuse the plan instead of rediscovering it.",
				"Store the plan in runtime/workspace state if that helps.",
				"Do not write the final SVG yet.",
				"Keep the answer short and describe only what you stored for reuse.",
			].join("\n"),
		},
		{
			id: "recursive-svg-natural-develop",
			title: "Develop the scene using the best workflow",
			request: [
				"Reuse the stored plan; do not start over.",
				"Work on the subproblems in the best way you judge appropriate for this task.",
				"Prefer reusable intermediate state over long prose, and avoid rediscovering the same decisions twice.",
				"Do not write the final SVG yet unless it is clearly the best choice.",
				"Keep the answer short and mention what became reusable state for the final turn.",
			].join("\n"),
		},
		{
			id: "recursive-svg-natural-compose",
			title: "Compose, inspect, and repair the final recursive SVG",
			request: [
				"Reuse prior plan/state rather than rediscovering it.",
				buildRecursiveSvgRequirements([
					"- After writing the file, inspect it and fix any obvious structural or SVG validity problems.",
					"- Final answer should contain only the file path and a one-line note.",
				]),
			].join("\n"),
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
}

function buildRlmRecursiveSvgNaturalLongTurns() {
	const title = "Refine a fresh recursive SVG scene over many turns while preserving and improving prior work.";
	const steps = [
		{
			id: "recursive-svg-long-base",
			title: "Create the base turtle-pie scene",
			request: [
				"Before writing the base version, think of a cute turtle and a tasty pizza pie that are obviously turtles and pizza pies, and feel alive, fresh, and fun.",
				"Combine those motifs into the first complete version of {{SVG_OUTPUT_PATH}} rather than defaulting to the same prior composition.",
				buildRecursiveSvgRequirements([
					"- This is the base version; make it clean and readable rather than overly detailed.",
					"- Store any reusable composition notes in runtime/workspace state if that helps later turns.",
					"- Final answer should contain only the file path and a one-line note.",
				]),
			].join("\n"),
		},
		{
			id: "recursive-svg-long-clarify",
			title: "Make the recursion clearer",
			request: [
				"Reuse the existing SVG at {{SVG_OUTPUT_PATH}}; do not start from scratch unless necessary.",
				"Make the recursive structure more obvious and legible at a glance.",
				"Improve the inner scene so it more clearly reads as turtles eating another pie inside the main pie.",
				"Preserve the existing constraints and keep the file valid SVG.",
				"Final answer should contain only the file path and a one-line note.",
			].join("\n"),
		},
		{
			id: "recursive-svg-long-add-turtle",
			title: "Add another turtle",
			request: [
				"Reuse the existing SVG at {{SVG_OUTPUT_PATH}}; do not throw away the current composition unless necessary.",
				"Add a fourth outer turtle eating the pie.",
				"Keep the scene balanced and readable, and preserve the recursive inner scene.",
				"Final answer should contain only the file path and a one-line note.",
			].join("\n"),
		},
		{
			id: "recursive-svg-long-add-pie-detail",
			title: "Add another pie interaction",
			request: [
				"Reuse the existing SVG at {{SVG_OUTPUT_PATH}}.",
				"Add one more pie-related interaction without cluttering the scene: for example a slice, crumb trail, or a small secondary pie reference near one turtle.",
				"Preserve readability and the recursive idea.",
				"Final answer should contain only the file path and a one-line note.",
			].join("\n"),
		},
		{
			id: "recursive-svg-long-visual-review",
			title: "Render a preview and critique the composition visually",
			request: [
				"Reuse the existing SVG at {{SVG_OUTPUT_PATH}}.",
				"Generate a PNG preview at {{SVG_PREVIEW_PATH}} using bash and a local SVG rasterizer.",
				"Try practical local options until one works: qlmanage, rsvg-convert, magick, inkscape, or another available renderer.",
				"Then inspect {{SVG_PREVIEW_PATH}} with read as an image and critique the composition visually.",
				"Focus on what still looks weak: silhouette clarity, crowding, recursive legibility, pie readability, or visual balance.",
				"Do not edit the SVG in this turn unless absolutely necessary; primarily produce a short visual critique for the next turn.",
				"Final answer should contain only the preview path and a one-line critique note.",
			].join("\n"),
		},
		{
			id: "recursive-svg-long-visual-revise",
			title: "Revise the SVG based on the visual critique",
			request: [
				"Reuse the existing SVG at {{SVG_OUTPUT_PATH}} and the visual critique from {{SVG_PREVIEW_PATH}}.",
				"Revise the SVG to address the most obvious visual problems you identified.",
				"Prefer targeted edits over restarting the whole composition.",
				"Keep the recursive idea strong and the scene readable.",
				"Final answer should contain only the file path and a one-line note.",
			].join("\n"),
		},
		{
			id: "recursive-svg-long-polish",
			title: "Render one more preview, then polish and validate the final scene",
			request: [
				"Reuse the existing SVG at {{SVG_OUTPUT_PATH}} rather than restarting.",
				"Generate an updated PNG preview at {{SVG_PREVIEW_PATH}} using bash and inspect it with read as an image.",
				"Make one final polish pass based on that visual review: improve spacing, silhouette clarity, and overall balance.",
				"Inspect the SVG and fix any obvious structural or validity issues.",
				"Keep the final file within the same core constraints: standalone 800x800 SVG, required groups, recursive pie scene, no external assets.",
				"Final answer should contain only the file path and a one-line note.",
			].join("\n"),
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
}

function buildPaperBufferReuseTurns() {
	const title = "Reuse buffered runtime state over multiple turns instead of replaying transcript prose.";
	const steps = [
		{
			id: "buffer-initial-findings",
			title: "Build initial buffers",
			request:
				"Inspect the local source and docs needed to explain the new RLM runtime helper surface. Store the most reusable findings in variables and commit only the durable summary into globalThis.workspace.",
		},
		{
			id: "reuse-buffers",
			title: "Reuse buffered findings",
			request:
				"Without restating the earlier transcript, reuse the runtime/workspace buffers you already built to explain how llm_query differs from rlm_query and when batch helpers should be used. Validate only if needed.",
		},
		{
			id: "final-buffered-consolidation",
			title: "Consolidate buffered state",
			request:
				"Consolidate the final reusable explanation, active refs, and any open questions into runtime/workspace so the answer depends on the notebook rather than long transcript replay.",
		},
	] as const;

	return steps.map((step) => ({
		id: step.id,
		title: step.title,
		prompt: `${prelude(title)}\n${step.request}`,
	}));
}

function buildRecursiveControlProbeTurns() {
	const title = "Probe whether the model can execute the minimal recursive control stack at all.";
	return [
		{
			id: "recursive-control-probe",
			title: "Enter runtime, launch one child, and commit once",
			prompt: `${prelude(title)}
Start in rlm_exec before any direct answer.
Inside that runtime call, do all of the following:
- inspect whether globalThis.context and globalThis.context.compiledContext exist,
- make exactly one rlm_query child call for a tiny subproblem,
- commit a short reusable note into globalThis.workspace,
- finalize from runtime with a compact success/failure summary.

A valid minimal shape is acceptable, for example:

action sketch:
const child = await rlm_query({
  prompt: "Reply with exactly: child-ok",
  budget: "low",
});
globalThis.workspace.commit({
  goal: "recursive control probe",
  findings: [
    \`compiledContext=\${Boolean(globalThis.context?.compiledContext)}\`,
    \`childOk=\${child.ok}\`,
    \`childAnswer=\${child.answer}\`,
  ],
});
final(\`runtime=yes child=\${child.ok ? child.answer : "failed"} commit=yes\`);

If the child call or commit fails, still report that after attempting it.
Final answer should be exactly one short line.`,
		},
	];
}

function buildRlmExecOnlyProbeTurns() {
	const title = "Probe whether the model can enter rlm_exec at all with the smallest possible runtime body.";
	return [
		{
			id: "rlm-exec-only-probe",
			title: "Enter runtime and finalize immediately",
			prompt: `${prelude(title)}
Start in rlm_exec before any direct answer.
Inside that runtime call, do only the minimal possible runtime action and then finalize.
Do not call any child helpers.
Do not use any direct tools first.
Do not add markdown fences or extra commentary.
A valid minimal runtime body is:
final("ok")
Final answer should be exactly: ok`,
		},
	];
}

function buildRlmExecCommitProbeTurns() {
	const title = "Probe whether the model can enter rlm_exec and make one tiny workspace commit.";
	return [
		{
			id: "rlm-exec-commit-probe",
			title: "Enter runtime, commit once, and finalize",
			prompt: `${prelude(title)}
Start in rlm_exec before any direct answer.
Inside that runtime call, make one tiny workspace commit and then finalize.
Do not call any child helpers.
Do not use any direct tools first.
Do not add markdown fences or extra commentary.
A valid minimal runtime body is:
globalThis.workspace.commit({ goal: "commit probe", findings: ["ok"] });
final("ok")
Final answer should be exactly: ok`,
		},
	];
}

function buildRlmExecChildProbeTurns() {
	const title = "Probe whether the model can enter rlm_exec and make one tiny child call after the simpler probes.";
	return [
		{
			id: "rlm-exec-child-probe",
			title: "Enter runtime, make one child call, and finalize",
			prompt: `${prelude(title)}
Start in rlm_exec before any direct answer.
Inside that runtime call, make exactly one tiny rlm_query child call, then finalize from the child result.
Do not commit anything in this probe.
Do not use any direct tools first.
Do not add markdown fences or extra commentary.
A valid minimal runtime body is:
const child = await rlm_query({ prompt: "Reply with exactly: child-ok", budget: "low" });
final(child.ok ? child.answer : "child-failed")
Final answer should be exactly one short line.`,
		},
	];
}

export function getEvalScenarios(): EvalScenario[] {
	return [
		{
			id: "extension-research",
			label: "Extension research and runtime reuse",
			description: "Multi-turn Pi extension research task that should reward root runtime reuse without code changes.",
			cwd: repoRoot,
			corpusSummary: ["Pi SDK docs and extension examples from node_modules", "This repo's README, src/, and tests/"],
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
			description:
				"Plan a realistic Pi extension implementation over multiple turns using docs, examples, and runtime notes.",
			cwd: repoRoot,
			corpusSummary: ["Pi extension docs/examples", "This repo's RLM implementation as a reference extension"],
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
			corpusSummary: ["This RLM extension source", "Pi docs/examples for prompt injection and SDK behavior"],
			extensionFlags: RLM_EVAL_FLAGS,
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
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildLongHorizonContextTurns(),
		},
		{
			id: "rlm-commit-discipline",
			label: "RLM commit discipline",
			description:
				"Short multi-turn scenario focused on whether the agent returns to the workspace after leaf-tool work.",
			cwd: repoRoot,
			corpusSummary: ["This RLM extension source", "Repeated reuse of runtime findings across turns"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildCommitDisciplineTurns(),
		},
		{
			id: "rlm-simple-control",
			label: "RLM simple control",
			description: "Short repo-grounded questions that should not require heavy coordinator behavior.",
			cwd: repoRoot,
			corpusSummary: ["This RLM extension README and package metadata"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: [
				{
					id: "version-question",
					title: "Ask for the package version",
					prompt: `${prelude("Answer a simple package metadata question.")}\nWhat is the package name and version in this repo? Keep the answer brief and cite the local source file path.`,
				},
				{
					id: "tool-list-question",
					title: "Ask for the tool list",
					prompt: `${prelude("Answer a simple README question.")}\nWhich three RLM tools does this package expose according to the README? Keep the answer short and grounded in the local README.`,
				},
			],
		},
		{
			id: "paper-runtime-surface",
			label: "Paper runtime surface",
			description:
				"Exercises context/history views, batched helpers, recursive helpers, and workspace commits in one scenario.",
			cwd: repoRoot,
			corpusSummary: ["This RLM extension source", "Repeated use of the paper-style runtime helpers"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildPaperRuntimeSurfaceTurns(),
		},
		{
			id: "paper-submodel-routing",
			label: "Paper submodel routing",
			description:
				"Exercises explicit provider/id[:thinking] child-model selection through simple and recursive helpers.",
			cwd: repoRoot,
			corpusSummary: ["This RLM extension source", "Explicit per-call submodel routing inside runtime helpers"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildPaperSubmodelRoutingTurns(),
		},
		{
			id: "paper-buffer-reuse",
			label: "Paper buffer reuse",
			description:
				"Checks whether runtime/workspace buffers are reused across turns instead of replaying transcript prose.",
			cwd: repoRoot,
			corpusSummary: ["This RLM extension source", "Multi-turn reuse of runtime variables and workspace state"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildPaperBufferReuseTurns(),
		},
		{
			id: "rlm-exec-only-probe",
			label: "RLM exec-only probe",
			description: "Single-turn probe for minimal runtime entry with no child calls or commits.",
			cwd: repoRoot,
			corpusSummary: ["Minimal explicit rlm_exec entry probe", "Runtime entry and immediate finalize"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildRlmExecOnlyProbeTurns(),
		},
		{
			id: "rlm-exec-commit-probe",
			label: "RLM exec + commit probe",
			description: "Single-turn probe for runtime entry plus one tiny workspace commit.",
			cwd: repoRoot,
			corpusSummary: ["Minimal explicit rlm_exec commit probe", "Runtime entry, one tiny commit, immediate finalize"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildRlmExecCommitProbeTurns(),
		},
		{
			id: "rlm-exec-child-probe",
			label: "RLM exec + child probe",
			description: "Single-turn probe for runtime entry plus one tiny child query after the simpler probes.",
			cwd: repoRoot,
			corpusSummary: ["Minimal explicit rlm_exec child probe", "Runtime entry, one tiny child query, immediate finalize"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildRlmExecChildProbeTurns(),
		},
		{
			id: "rlm-recursive-control-probe",
			label: "RLM recursive control probe",
			description:
				"Single-turn probe for the minimal recursive control stack: one runtime entry, one child query, and one workspace commit.",
			cwd: repoRoot,
			corpusSummary: ["Minimal explicit recursive-control probe", "Runtime entry, one child helper, one durable commit"],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildRecursiveControlProbeTurns(),
		},
		{
			id: "paper-recursive-svg-proof",
			label: "Paper recursive SVG proof",
			description:
				"Fresh recursive SVG task that explicitly probes runtime planning, child helpers, reuse, and final artifact composition.",
			cwd: repoRoot,
			corpusSummary: [
				"A fresh generated recursive SVG artifact",
				"Explicit proof of runtime/helper use, reuse, and grounded file composition",
			],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildPaperRecursiveSvgProofTurns(),
		},
		{
			id: "rlm-recursive-svg-natural",
			label: "RLM recursive SVG natural",
			description:
				"Fresh recursive SVG task that tests natural routing and decomposition without naming helper APIs in the task.",
			cwd: repoRoot,
			corpusSummary: [
				"A fresh generated recursive SVG artifact",
				"Natural routing between direct tools, runtime state, and decomposition",
			],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildRlmRecursiveSvgNaturalTurns(),
		},
		{
			id: "rlm-recursive-svg-natural-long",
			label: "RLM recursive SVG natural long",
			description:
				"Longer fresh recursive SVG refinement task that tests reuse, iterative improvement, and whether decomposition emerges as complexity grows.",
			cwd: repoRoot,
			corpusSummary: [
				"A fresh generated recursive SVG artifact refined over many turns",
				"Natural reuse of prior file state, runtime/workspace state, and iterative composition",
			],
			extensionFlags: RLM_EVAL_FLAGS,
			turns: buildRlmRecursiveSvgNaturalLongTurns(),
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
