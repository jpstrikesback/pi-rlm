import type {
	LlmQueryRole,
	RlmArtifactIndex,
	RlmArtifactSummary,
	RlmChildArtifact,
	RlmValueManifest,
	RlmWorkspace,
	RlmWorkspaceManifest,
} from "./types.js";

export const INTERNAL_LLM_QUERY_CONTEXT_KEY = "__rlmRuntimeContext";
export const MAX_WORKSPACE_ARTIFACTS = 24;

const DEFAULT_MANIFEST_SECTION_LIMIT = 6;
const DEFAULT_KEY_PREVIEW_LIMIT = 8;
const DEFAULT_ARRAY_PREVIEW_LIMIT = 3;
const DEFAULT_ARTIFACT_PREVIEW_LIMIT = 4;
const WORKSPACE_RUNTIME_PATH = "globalThis.workspace" as const;
const PARENT_STATE_RUNTIME_PATH = "globalThis.parentState" as const;
const INPUT_RUNTIME_PATH = "globalThis.input" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const next = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return next.length > 0 ? next : undefined;
}

function normalizeArtifactList(value: unknown): RlmChildArtifact[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is RlmChildArtifact => isRecord(item) && typeof item.childId === "string");
}

function ensureArtifactIndexShape(value: unknown): RlmArtifactIndex {
	const index = isRecord(value) ? (value as RlmArtifactIndex) : {};
	if (!isRecord(index.byId)) index.byId = {};
	if (!isRecord(index.byTag)) index.byTag = {};
	if (!isRecord(index.byFile)) index.byFile = {};
	if (!Array.isArray(index.recentIds)) index.recentIds = [];
	return index;
}

export function ensureWorkspaceShape(value: unknown): RlmWorkspace {
	const workspace = (isRecord(value) ? value : {}) as RlmWorkspace;
	workspace.childArtifacts = normalizeArtifactList(workspace.childArtifacts);
	workspace.childArtifactSummaries = Array.isArray(workspace.childArtifactSummaries)
		? workspace.childArtifactSummaries.filter((item): item is RlmArtifactSummary => isRecord(item) && typeof item.id === "string")
		: workspace.childArtifacts.map(toArtifactSummary);
	workspace.artifactIndex = ensureArtifactIndexShape(workspace.artifactIndex);
	if (!workspace.artifactIndex.recentIds?.length && workspace.childArtifacts.length > 0) {
		workspace.artifactIndex = rebuildArtifactIndex(workspace.childArtifacts);
	}
	workspace.meta = isRecord(workspace.meta)
		? ({ version: 1, ...(workspace.meta as Record<string, unknown>) } as RlmWorkspace["meta"])
		: { version: 1 };
	return workspace;
}

function extractArtifactFiles(artifact: Partial<RlmChildArtifact>): string[] | undefined {
	const direct = normalizeStringList(artifact.files);
	if (direct) return direct;
	if (artifact.data && isRecord(artifact.data)) {
		const nestedFiles = normalizeStringList((artifact.data as Record<string, unknown>).files);
		if (nestedFiles) return nestedFiles;
	}
	return undefined;
}

function extractArtifactTags(artifact: Partial<RlmChildArtifact>): string[] | undefined {
	const direct = normalizeStringList(artifact.tags);
	if (direct) return direct;
	if (artifact.data && isRecord(artifact.data)) {
		const nestedTags = normalizeStringList((artifact.data as Record<string, unknown>).tags);
		if (nestedTags) return nestedTags;
	}
	return undefined;
}

export function toArtifactSummary(artifact: RlmChildArtifact): RlmArtifactSummary {
	return {
		id: artifact.id,
		childId: artifact.childId,
		role: artifact.role,
		status: artifact.status,
		...(artifact.summary ? { summary: artifact.summary } : {}),
		...(artifact.files ? { files: artifact.files } : {}),
		...(artifact.tags ? { tags: artifact.tags } : {}),
		...(artifact.producedAt ? { producedAt: artifact.producedAt } : {}),
	};
}

function rebuildArtifactIndex(artifacts: RlmChildArtifact[]): RlmArtifactIndex {
	const byId: Record<string, RlmChildArtifact> = {};
	const byTag: Record<string, string[]> = {};
	const byFile: Record<string, string[]> = {};
	const recentIds: string[] = [];

	for (const artifact of artifacts) {
		byId[artifact.id] = artifact;
		recentIds.push(artifact.id);
		for (const tag of artifact.tags ?? []) {
			(byTag[tag] ??= []).push(artifact.id);
		}
		for (const file of artifact.files ?? []) {
			(byFile[file] ??= []).push(artifact.id);
		}
	}

	return { byId, byTag, byFile, recentIds };
}

export function recordArtifact(workspaceValue: unknown, artifactValue: RlmChildArtifact, maxArtifacts = MAX_WORKSPACE_ARTIFACTS): RlmWorkspace {
	const workspace = ensureWorkspaceShape(workspaceValue);
	const artifact: RlmChildArtifact = {
		...structuredClone(artifactValue),
		files: extractArtifactFiles(artifactValue),
		tags: extractArtifactTags(artifactValue),
	};
	const existing = workspace.childArtifacts ?? [];
	const nextArtifacts = [...existing.slice(-(maxArtifacts - 1)), artifact];
	workspace.childArtifacts = nextArtifacts;
	workspace.lastChildArtifact = artifact;
	workspace.childArtifactSummaries = nextArtifacts.map(toArtifactSummary);
	workspace.artifactIndex = rebuildArtifactIndex(nextArtifacts);
	workspace.meta = {
		version: 1,
		...(workspace.meta || {}),
		updatedAt: artifact.producedAt,
	};
	return workspace;
}

function createScalarPreview(value: unknown): unknown {
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
	return undefined;
}

export function buildValueManifest(
	value: unknown,
	path: string,
	options: {
		keyPreviewLimit?: number;
		arrayPreviewLimit?: number;
	} = {},
): RlmValueManifest {
	const keyPreviewLimit = options.keyPreviewLimit ?? DEFAULT_KEY_PREVIEW_LIMIT;
	const arrayPreviewLimit = options.arrayPreviewLimit ?? DEFAULT_ARRAY_PREVIEW_LIMIT;

	if (value === null) return { path, type: "null", preview: null };
	if (Array.isArray(value)) {
		const preview = value
			.slice(0, arrayPreviewLimit)
			.map(createScalarPreview)
			.filter((item) => item !== undefined);
		return {
			path,
			type: "array",
			length: value.length,
			...(preview.length > 0 ? { preview } : {}),
		};
	}
	if (typeof value === "string") return { path, type: "string", length: value.length, preview: createScalarPreview(value) };
	if (typeof value === "number" || typeof value === "boolean" || value === undefined)
		return { path, type: value === undefined ? "undefined" : typeof value, preview: value };
	if (isRecord(value)) {
		const keys = Object.keys(value);
		return {
			path,
			type: "object",
			keyCount: keys.length,
			keys: keys.slice(0, keyPreviewLimit),
		};
	}
	return { path, type: typeof value };
}

export function buildStateManifest(state: Record<string, unknown> | undefined): RlmValueManifest | undefined {
	if (!state || !isRecord(state) || Object.keys(state).length === 0) return undefined;
	return buildValueManifest(state, PARENT_STATE_RUNTIME_PATH);
}

export function buildWorkspaceManifest(
	workspaceValue: unknown,
	options: {
		sectionKeys?: string[];
		relevantArtifacts?: RlmArtifactSummary[];
		sectionLimit?: number;
	} = {},
): RlmWorkspaceManifest | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	const workspace = ensureWorkspaceShape(workspaceValue);
	const rawKeys = options.sectionKeys?.length
		? options.sectionKeys
		: Object.keys(workspace).filter((key) => key !== "artifactIndex" && key !== "lastChildArtifact" && key !== "childArtifactSummaries");
	const sectionKeys = rawKeys.slice(0, options.sectionLimit ?? DEFAULT_MANIFEST_SECTION_LIMIT);
	const sections: Record<string, RlmValueManifest> = {};
	for (const key of sectionKeys) {
		if (!(key in workspace)) continue;
		sections[key] = buildValueManifest((workspace as Record<string, unknown>)[key], `${WORKSPACE_RUNTIME_PATH}.${key}`);
	}
	return {
		version: 1,
		runtime: {
			workspacePath: WORKSPACE_RUNTIME_PATH,
			parentStatePath: PARENT_STATE_RUNTIME_PATH,
			inputPath: INPUT_RUNTIME_PATH,
		},
		sections,
		artifactCount: workspace.childArtifacts?.length ?? 0,
		...(workspace.artifactIndex?.recentIds?.length ? { recentArtifactIds: workspace.artifactIndex.recentIds.slice(-DEFAULT_ARTIFACT_PREVIEW_LIMIT) } : {}),
		...(options.relevantArtifacts?.length ? { relevantArtifacts: options.relevantArtifacts } : {}),
	};
}

function tokenizePrompt(prompt: string): string[] {
	return Array.from(new Set(prompt.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])).slice(0, 24);
}

function artifactScore(summary: RlmArtifactSummary, tokens: string[], role: LlmQueryRole): number {
	let score = 0;
	if (summary.role === role) score += 2;
	const haystacks = [summary.summary ?? "", ...(summary.files ?? []), ...(summary.tags ?? [])].map((value) => value.toLowerCase());
	for (const token of tokens) {
		if (haystacks.some((value) => value.includes(token))) score += 3;
	}
	return score;
}

export function selectRelevantArtifacts(
	workspaceValue: unknown,
	options: {
		prompt: string;
		role: LlmQueryRole;
		limit?: number;
	} = { prompt: "", role: "general" },
): RlmArtifactSummary[] {
	if (!isRecord(workspaceValue)) return [];
	const workspace = ensureWorkspaceShape(workspaceValue);
	const summaries = workspace.childArtifactSummaries ?? workspace.childArtifacts?.map(toArtifactSummary) ?? [];
	const tokens = tokenizePrompt(options.prompt);
	const ranked = summaries
		.map((summary, index) => ({ summary, index, score: artifactScore(summary, tokens, options.role) }))
		.sort((a, b) => (b.score - a.score) || (b.index - a.index))
		.map((entry) => entry.summary);
	const limit = options.limit ?? DEFAULT_ARTIFACT_PREVIEW_LIMIT;
	const matched = ranked.filter((summary) => artifactScore(summary, tokens, options.role) > 0).slice(0, limit);
	if (matched.length > 0) return matched;
	return ranked.slice(-limit).reverse();
}

export function selectRelevantWorkspaceSectionKeys(role: LlmQueryRole, workspaceValue: unknown): string[] {
	if (!isRecord(workspaceValue)) return [];
	const workspace = ensureWorkspaceShape(workspaceValue);
	const byRole: Record<LlmQueryRole, string[]> = {
		general: ["goal", "plan", "files", "findings", "partialOutputs", "childArtifacts"],
		scout: ["files", "findings", "childArtifacts", "openQuestions"],
		planner: ["goal", "plan", "openQuestions", "partialOutputs", "childArtifacts"],
		worker: ["files", "findings", "partialOutputs", "childArtifacts"],
		reviewer: ["findings", "partialOutputs", "childArtifacts", "openQuestions"],
	};
	return byRole[role].filter((key) => key in workspace);
}

export function attachInternalLlmQueryContext<T>(input: T, context: { workspace?: RlmWorkspace | null }): T {
	if (!isRecord(input)) return input;
	if (context.workspace === undefined) return input;
	return {
		...(input as Record<string, unknown>),
		[INTERNAL_LLM_QUERY_CONTEXT_KEY]: context,
	} as T;
}

export function splitInternalLlmQueryContext(input: unknown): {
	publicInput: unknown;
	workspace?: RlmWorkspace | null;
} {
	if (!isRecord(input) || !(INTERNAL_LLM_QUERY_CONTEXT_KEY in input)) return { publicInput: input };
	const next = { ...input };
	const internal = next[INTERNAL_LLM_QUERY_CONTEXT_KEY];
	delete next[INTERNAL_LLM_QUERY_CONTEXT_KEY];
	const workspace = isRecord(internal) || internal === null ? ((internal as { workspace?: RlmWorkspace | null })?.workspace ?? undefined) : undefined;
	return { publicInput: next, workspace };
}
