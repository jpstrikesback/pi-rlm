import type {
	LlmQueryBudget,
	LlmQueryBudgetPreset,
	LlmQueryOutputMode,
	LlmQueryRequest,
	LlmQueryResult,
	NormalizedLlmQueryRequest,
	RlmWorkspace,
} from "./types.js";
import {
	buildCompiledPromptContext,
	renderCompiledPromptContext,
	buildWorkspacePointerHints,
} from "./workspace.js";

export const BUDGET_PRESETS: Record<LlmQueryBudgetPreset, LlmQueryBudget> = {
	low: { maxDepth: 1, maxTurns: 3 },
	medium: { maxDepth: 2, maxTurns: 5 },
	high: { maxDepth: 3, maxTurns: 8 },
};

function cloneState<T>(value: T): T | undefined {
	if (value === undefined) return undefined;
	try {
		return structuredClone(value);
	} catch {
		throw new Error("llmQuery.state must be structured-cloneable");
	}
}

function normalizeBudget(budget: LlmQueryRequest["budget"]): LlmQueryBudget {
	if (!budget) return { ...BUDGET_PRESETS.medium };
	if (typeof budget === "string") return { ...BUDGET_PRESETS[budget] };
	return {
		maxDepth: budget.maxDepth ?? BUDGET_PRESETS.medium.maxDepth,
		maxTurns: budget.maxTurns ?? BUDGET_PRESETS.medium.maxTurns,
	};
}

function normalizeOutput(output: LlmQueryRequest["output"]): {
	mode: LlmQueryOutputMode;
	schema?: Record<string, string>;
} {
	return {
		mode: output?.mode ?? "text",
		schema: output?.schema,
	};
}

export function normalizeLlmQueryInput(input: LlmQueryRequest): NormalizedLlmQueryRequest {
	if (!input || typeof input !== "object" || typeof input.prompt !== "string" || !input.prompt.trim()) {
		throw new Error("llmQuery input must be an object with a non-empty prompt");
	}

	return {
		prompt: input.prompt,
		role: input.role ?? "general",
		state: cloneState(input.state),
		tools: input.tools ?? "read-only",
		budget: normalizeBudget(input.budget),
		model: typeof input.model === "string" && input.model.trim().length > 0 ? (input.model.trim() as NormalizedLlmQueryRequest["model"]) : undefined,
		output: normalizeOutput(input.output),
	};
}

type BuildChildPromptContext = {
	workspace?: RlmWorkspace | null;
};

function buildParentStateKeyHint(state: Record<string, unknown> | undefined): string | undefined {
	if (!state) return undefined;
	const keys = Object.keys(state).filter((key) => typeof key === "string" && key.trim().length > 0);
	return keys.length > 0 ? keys.slice(0, 8).join(", ") : undefined;
}

export function buildChildPrompt(input: NormalizedLlmQueryRequest, context: BuildChildPromptContext = {}): string {
	const sections: string[] = [];
	const workingSetPointers = buildWorkspacePointerHints(context.workspace);
	const parentStateKeys = buildParentStateKeyHint(input.state);
	const compiled = buildCompiledPromptContext(context.workspace ?? undefined, {
		prompt: input.prompt,
		role: input.role,
		parentState: input.state,
		evidenceItemLimit: 4,
		evidenceCheckpointLimit: 3,
		artifactLimit: 4,
		exactValueLimit: 2,
	});

	sections.push("You are a recursive RLM child node.");
	sections.push(`Role: ${input.role}`);
	sections.push("Compiled working set:");
	sections.push(renderCompiledPromptContext(compiled, {
		title: "Deterministic compiled child working set from externalized state.",
	}));
	sections.push("Runtime state access:");
	sections.push(workingSetPointers ?? "- Task snapshot: globalThis.context\n- Deterministic compiled working set: globalThis.context.compiledContext\n- Inspect globalThis.workspace.activeContext first.\n- Durable notebook: globalThis.workspace\n- Recent history metadata only: globalThis.history\n- Parent-provided local state: globalThis.parentState\n- Input alias: globalThis.input");
	if (parentStateKeys) sections.push(`Parent state keys: ${parentStateKeys}`);

	sections.push("Rules:");
	sections.push("- Solve only the requested subproblem.");
	sections.push("- Treat globalThis.context.compiledContext as the primary prompt-visible working set.");
	sections.push("- Inspect globalThis.context first, then globalThis.workspace.activeContext.");
	sections.push("- Treat globalThis.history as minimal metadata only, not working memory.");
	sections.push("- Use llm_query for simple extraction or summarization and rlm_query for deeper iterative work.");
	sections.push("- Reuse selected handles, workspace state, and artifact refs before rediscovering information.");
	sections.push("- Treat prompt metadata as a pointer to runtime state, not as the full state.");
	sections.push("- Batch independent subtasks with llm_query_batched or rlm_query_batched instead of many tiny sequential calls.");
	sections.push("- After any meaningful leaf-tool work or reusable finding, call globalThis.workspace.commit({...}) before finalizing.");
	sections.push("- Keep the final answer compact, structured, and easy for the parent to reuse.");
	if (input.budget.maxTurns) sections.push(`- Finish within ${input.budget.maxTurns} turns.`);

	if (input.output.mode === "json") {
		sections.push("- Return valid JSON only. Do not wrap it in markdown fences.");
		if (input.output.schema) {
			sections.push(`Requested JSON shape:\n${JSON.stringify(input.output.schema, null, 2)}`);
		}
	} else {
		sections.push("- Return only the final useful answer, without extra preamble.");
	}
	if (input.model) sections.push(`Requested child model: ${input.model}`);

	sections.push(`Task:\n${input.prompt}`);

	return sections.join("\n\n");
}

function extractJsonCandidate(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	const startObj = text.indexOf("{");
	const endObj = text.lastIndexOf("}");
	if (startObj !== -1 && endObj > startObj) return text.slice(startObj, endObj + 1);
	return undefined;
}

export function parseChildResult(text: string, input: NormalizedLlmQueryRequest, turns: number): LlmQueryResult {
	const trimmed = text.trim();
	if (input.output.mode === "json") {
		const candidate = extractJsonCandidate(trimmed) ?? trimmed;
		try {
			const data = JSON.parse(candidate) as Record<string, unknown>;
			const summary = typeof data.summary === "string" ? data.summary : undefined;
			return {
				ok: true,
				answer: trimmed,
				summary,
				data,
				role: input.role,
				usage: { turns },
			};
		} catch {
			return {
				ok: false,
				answer: trimmed,
				role: input.role,
				usage: { turns },
				error: "Failed to parse JSON child output",
			};
		}
	}

	if (!trimmed) {
		return {
			ok: false,
			answer: "",
			role: input.role,
			usage: { turns },
			error: "Child returned empty output",
		};
	}

	return {
		ok: true,
		answer: trimmed,
		summary: trimmed,
		role: input.role,
		usage: { turns },
	};
}
