import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { EvalCommitTruthfulness, EvalPathCitation, ProxyLogEntry, ProxyUsage } from "./types.js";

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

const COMMIT_CLAIM_PATTERNS: RegExp[] = [
	/\b(?:i|we)\s+(?:have\s+|had\s+|also\s+|already\s+)?(?:re-?)?committed\b/iu,
	/\b(?:i|we)\s+(?:have\s+)?committed\b[^.\n]*\b(?:into|to|back into|back to)\b[^.\n]*\b(?:workspace|globalThis\.workspace)\b/iu,
	/\b(?:re-?)?committed\b[^.\n]*\b(?:workspace|globalThis\.workspace)\b/iu,
];

const KNOWN_RELATIVE_ROOTS = /^(?:src|tests|docs|scripts|eval|examples|node_modules|dist)\//i;
const KNOWN_TOP_LEVEL_FILES = new Set([
	"README.md",
	"package.json",
	"tsconfig.json",
	"tsconfig.build.json",
	"AGENTS.md",
]);
const FILE_LIKE_EXTENSION = /\.(?:ts|tsx|js|jsx|json|md|txt|yml|yaml|mjs|cjs|css|html|sh|py|rs|go)$/i;
const PATH_TOKEN_RE = /(?:\/[^\s`"'(),:;\]]+)+|(?:\.{1,2}\/[^\s`"'(),:;\]]+)+|(?:[A-Za-z0-9_.-]+\/(?:[^\s`"'(),:;\]]+))+|(?:[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|txt|yml|yaml|mjs|cjs|css|html|sh|py|rs|go))/g;

function normalizeCandidateToken(token: string): string {
	return token.replace(/^[`'"([{<]+|[`'"\])}>.,:;!?]+$/g, "").trim();
}

function isLikelyLocalPathToken(token: string): boolean {
	if (!token) return false;
	if (token.includes("://")) return false;
	if (token.startsWith("globalThis.")) return false;
	if (token.includes("workspace.commit")) return false;
	if (path.isAbsolute(token)) return true;
	if (token.startsWith("./") || token.startsWith("../")) return true;
	if (KNOWN_TOP_LEVEL_FILES.has(token)) return true;
	if (KNOWN_RELATIVE_ROOTS.test(token)) return true;
	if (FILE_LIKE_EXTENSION.test(token) && !token.includes(":")) return true;
	return false;
}

function resolveCitationPath(cited: string, repoRoot: string): string {
	if (path.isAbsolute(cited)) return path.normalize(cited);
	return path.resolve(repoRoot, cited);
}

export function analyzeCommitTruthfulness(assistantText: string, actualCommitCount: number): EvalCommitTruthfulness {
	const claimSignals = COMMIT_CLAIM_PATTERNS
		.flatMap((pattern) => {
			const match = assistantText.match(pattern);
			return match?.[0] ? [match[0]] : [];
		});
	const claimedCommit = claimSignals.length > 0;
	const actualCommit = actualCommitCount > 0;
	return {
		claimedCommit,
		actualCommit,
		falseClaim: claimedCommit && !actualCommit,
		claimSignals: Array.from(new Set(claimSignals)),
	};
}

export function analyzeAssistantPathCitations(assistantText: string, repoRoot: string): EvalPathCitation[] {
	const candidates = Array.from(new Set((assistantText.match(PATH_TOKEN_RE) ?? []).map(normalizeCandidateToken).filter(isLikelyLocalPathToken)));
	return candidates.map((cited) => {
		const resolvedPath = resolveCitationPath(cited, repoRoot);
		if (!existsSync(resolvedPath)) {
			return { cited, resolvedPath, exists: false };
		}
		const stats = statSync(resolvedPath);
		return {
			cited,
			resolvedPath,
			exists: true,
			kind: stats.isDirectory() ? "directory" : "file",
		};
	});
}

export function computeRepeatedReadRatio(readPaths: string[]): number | undefined {
	if (readPaths.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const path of readPaths) {
		counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	let repeatedReads = 0;
	for (const count of counts.values()) {
		if (count > 1) repeatedReads += count - 1;
	}
	return repeatedReads / readPaths.length;
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
