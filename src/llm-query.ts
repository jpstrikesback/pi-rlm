import type {
	LlmQueryBudget,
	LlmQueryBudgetPreset,
	LlmQueryOutputMode,
	LlmQueryRequest,
	LlmQueryResult,
	NormalizedLlmQueryRequest,
} from "./types.js";

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
		output: normalizeOutput(input.output),
	};
}

export function buildChildPrompt(input: NormalizedLlmQueryRequest): string {
	const sections: string[] = [];
	sections.push("You are a recursive RLM child node.");
	sections.push(`Role: ${input.role}`);
	sections.push(`Prompt:\n${input.prompt}`);

	if (input.state && Object.keys(input.state).length > 0) {
		sections.push(
			`Parent-provided state is available both in this prompt and in runtime as globalThis.input / globalThis.parentState:\n${JSON.stringify(input.state, null, 2)}`,
		);
	}

	sections.push("Rules:");
	sections.push("- Solve only the requested subproblem.");
	sections.push("- Reuse provided parent state before rediscovering information.");
	sections.push("- Keep the answer compact and useful to the parent.");
	if (input.budget.maxTurns) sections.push(`- Finish within ${input.budget.maxTurns} turns.`);

	if (input.output.mode === "json") {
		sections.push("- Return valid JSON only. Do not wrap it in markdown fences.");
		if (input.output.schema) {
			sections.push(`Requested JSON shape:\n${JSON.stringify(input.output.schema, null, 2)}`);
		}
	} else {
		sections.push("- Return only the final useful answer, without extra preamble.");
	}

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

	return {
		ok: true,
		answer: trimmed,
		summary: trimmed,
		role: input.role,
		usage: { turns },
	};
}
