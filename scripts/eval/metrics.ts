import type { ProxyLogEntry, ProxyUsage } from "./types.js";

const EMPTY_USAGE: ProxyUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cacheHitTokens: 0,
	cacheMissTokens: 0,
};

export function stableStringify(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return Object.fromEntries(entries.map(([key, inner]) => [key, sortValue(inner)]));
}

export function canonicalizeProviderPayload(payload: unknown): string {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return stableStringify(payload);
	const source = payload as Record<string, unknown>;
	const canonical: Record<string, unknown> = {};
	for (const key of [
		"model",
		"messages",
		"input",
		"stream",
		"stream_options",
		"tools",
		"tool_choice",
		"temperature",
		"max_tokens",
		"max_completion_tokens",
		"max_output_tokens",
		"reasoning_effort",
		"reasoning",
		"enable_thinking",
		"chat_template_kwargs",
		"prompt_cache_key",
		"prompt_cache_retention",
		"service_tier",
	]) {
		if (key in source) canonical[key] = source[key];
	}
	for (const key of Object.keys(source).sort()) {
		if (key in canonical) continue;
		canonical[key] = source[key];
	}
	return stableStringify(canonical);
}

export function longestCommonPrefixChars(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let i = 0;
	while (i < limit && left.charCodeAt(i) === right.charCodeAt(i)) i += 1;
	return i;
}

export function safeRatio(numerator: number, denominator: number): number {
	if (denominator <= 0) return 0;
	return numerator / denominator;
}

export function sumUsage(entries: Array<Pick<ProxyLogEntry, "usage">>): ProxyUsage {
	return entries.reduce<ProxyUsage>(
		(acc, entry) => ({
			promptTokens: acc.promptTokens + (entry.usage?.promptTokens ?? 0),
			completionTokens: acc.completionTokens + (entry.usage?.completionTokens ?? 0),
			totalTokens: acc.totalTokens + (entry.usage?.totalTokens ?? 0),
			cacheHitTokens: acc.cacheHitTokens + (entry.usage?.cacheHitTokens ?? 0),
			cacheMissTokens: acc.cacheMissTokens + (entry.usage?.cacheMissTokens ?? 0),
		}),
		{ ...EMPTY_USAGE },
	);
}

export function parseProviderUsage(
	format: "openai-completions" | "openai-responses",
	responseText: string,
): ProxyUsage | undefined {
	const parsed = tryParseJson(responseText);
	const directUsage = parsed !== undefined ? extractUsage(format, parsed) : undefined;
	if (directUsage) return directUsage;

	let lastUsage: ProxyUsage | undefined;
	for (const line of responseText.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const chunk = trimmed.slice(5).trim();
		if (!chunk || chunk === "[DONE]") continue;
		const parsedChunk = tryParseJson(chunk);
		const usage = parsedChunk !== undefined ? extractUsage(format, parsedChunk) : undefined;
		if (usage) lastUsage = usage;
	}
	return lastUsage;
}

export function parseMlxUsage(responseText: string): ProxyUsage | undefined {
	return parseProviderUsage("openai-completions", responseText);
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function extractUsage(
	format: "openai-completions" | "openai-responses",
	value: unknown,
): ProxyUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	if (format === "openai-responses") {
		const record = value as Record<string, unknown>;
		if (record.type === "response.completed" && record.response && typeof record.response === "object") {
			return extractOpenAiResponsesUsage((record.response as Record<string, unknown>).usage);
		}
		return extractOpenAiResponsesUsage(record.usage);
	}
	return extractOpenAiCompletionsUsage((value as Record<string, unknown>).usage);
}

function extractOpenAiCompletionsUsage(usage: unknown): ProxyUsage | undefined {
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const promptTokens = numberField((usage as Record<string, unknown>).prompt_tokens);
	const completionTokens = numberField((usage as Record<string, unknown>).completion_tokens);
	const totalTokens = numberField((usage as Record<string, unknown>).total_tokens);
	if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return undefined;
	const promptTokenDetails = (usage as Record<string, unknown>).prompt_tokens_details;
	const cacheHitTokens =
		promptTokenDetails && typeof promptTokenDetails === "object" && !Array.isArray(promptTokenDetails)
			? numberField((promptTokenDetails as Record<string, unknown>).cached_tokens) ?? 0
			: 0;
	return {
		promptTokens,
		completionTokens,
		totalTokens,
		cacheHitTokens,
		cacheMissTokens: Math.max(promptTokens - cacheHitTokens, 0),
	};
}

function extractOpenAiResponsesUsage(usage: unknown): ProxyUsage | undefined {
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const promptTokens = numberField((usage as Record<string, unknown>).input_tokens);
	const completionTokens = numberField((usage as Record<string, unknown>).output_tokens);
	const totalTokens = numberField((usage as Record<string, unknown>).total_tokens);
	if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return undefined;
	const inputTokenDetails = (usage as Record<string, unknown>).input_tokens_details;
	const cacheHitTokens =
		inputTokenDetails && typeof inputTokenDetails === "object" && !Array.isArray(inputTokenDetails)
			? numberField((inputTokenDetails as Record<string, unknown>).cached_tokens) ?? 0
			: 0;
	return {
		promptTokens,
		completionTokens,
		totalTokens,
		cacheHitTokens,
		cacheMissTokens: Math.max(promptTokens - cacheHitTokens, 0),
	};
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
