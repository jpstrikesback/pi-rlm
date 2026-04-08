import type {
	LlmQueryRole,
	RlmActiveContext,
	RlmArtifactIndex,
	RlmArtifactSummary,
	RlmChildArtifact,
	RlmConsolidationRef,
	RlmLease,
	RlmRetentionMetrics,
	RlmRetentionPolicy,
	RlmValueManifest,
	RlmWorkspace,
	RlmWorkspaceManifest,
	RlmWorkspaceMeta,
} from "./types.js";

export const INTERNAL_LLM_QUERY_CONTEXT_KEY = "__rlmRuntimeContext";
export const MAX_WORKSPACE_ARTIFACTS = 24;

const DEFAULT_MANIFEST_SECTION_LIMIT = 6;
const DEFAULT_KEY_PREVIEW_LIMIT = 8;
const DEFAULT_ARRAY_PREVIEW_LIMIT = 3;
const DEFAULT_ARTIFACT_PREVIEW_LIMIT = 4;
const MAX_RETENTION_LEASES = 24;
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

function normalizeStringArray(value: unknown, limit?: number): string[] | undefined {
	const list = normalizeStringList(value);
	if (!list) return undefined;
	const next = typeof limit === "number" ? list.slice(0, limit) : list;
	return next.length > 0 ? next : undefined;
}

function extractReferenceList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const refs = value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		return [record.ref, record.path, record.id].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
	});
	const unique = Array.from(new Set(refs));
	return unique.length > 0 ? unique : undefined;
}

function buildDerivedActiveContext(workspace: RlmWorkspace): RlmActiveContext {
	const goal = typeof workspace.goal === "string" && workspace.goal.trim().length > 0 ? workspace.goal.trim() : undefined;
	const currentPlan = normalizeStringArray(workspace.plan, 8);
	const relevantFiles = normalizeStringArray(workspace.files, 8);
	const currentQuestions = normalizeStringArray(workspace.openQuestions, 6);
	const currentArtifactRefs = normalizeStringArray(workspace.artifactIndex?.recentIds, 6);
	const currentFindingsRefs = Array.from(
		new Set([
			...(extractReferenceList(workspace.findings) ?? []),
			...(workspace.partialOutputs && isRecord(workspace.partialOutputs) ? Object.keys(workspace.partialOutputs) : []),
		]),
	);
	const summaryParts: string[] = [];
	if (goal) summaryParts.push(`Goal: ${goal}`);
	if (currentPlan?.length) summaryParts.push(`Plan: ${currentPlan.slice(0, 3).join(" · ")}`);
	if (relevantFiles?.length) summaryParts.push(`Files: ${relevantFiles.slice(0, 4).join(", ")}`);
	if (currentQuestions?.length) summaryParts.push(`Questions: ${currentQuestions.slice(0, 3).join(" · ")}`);
	if (currentArtifactRefs?.length) summaryParts.push(`Artifacts: ${currentArtifactRefs.slice(-4).join(", ")}`);
	const summary = summaryParts.length > 0 ? summaryParts.join("\n") : undefined;
	const updatedAt = typeof workspace.meta?.updatedAt === "string" ? workspace.meta.updatedAt : workspace.lastChildArtifact?.producedAt;
	return {
		...(goal ? { goal } : {}),
		...(currentPlan ? { currentPlan } : {}),
		...(relevantFiles ? { relevantFiles } : {}),
		...(currentQuestions ? { currentQuestions } : {}),
		...(currentFindingsRefs.length > 0 ? { currentFindingsRefs } : {}),
		...(currentArtifactRefs ? { currentArtifactRefs } : {}),
		...(summary ? { summary } : {}),
		...(updatedAt ? { updatedAt } : {}),
	};
}

function refreshWorkspaceProjection(workspace: RlmWorkspace): RlmWorkspace {
	const derived = buildDerivedActiveContext(workspace);
	const existing = isRecord(workspace.activeContext) ? (workspace.activeContext as RlmActiveContext) : {};
	workspace.activeContext = {
		...(derived.goal ? { goal: derived.goal } : {}),
		...(existing.goal && !derived.goal ? { goal: existing.goal } : {}),
		...(derived.currentPlan ? { currentPlan: derived.currentPlan } : {}),
		...(existing.currentPlan && !derived.currentPlan ? { currentPlan: existing.currentPlan } : {}),
		...(derived.relevantFiles ? { relevantFiles: derived.relevantFiles } : {}),
		...(existing.relevantFiles && !derived.relevantFiles ? { relevantFiles: existing.relevantFiles } : {}),
		...(derived.currentQuestions ? { currentQuestions: derived.currentQuestions } : {}),
		...(existing.currentQuestions && !derived.currentQuestions ? { currentQuestions: existing.currentQuestions } : {}),
		...(derived.currentFindingsRefs ? { currentFindingsRefs: derived.currentFindingsRefs } : {}),
		...(existing.currentFindingsRefs && !derived.currentFindingsRefs ? { currentFindingsRefs: existing.currentFindingsRefs } : {}),
		...(derived.currentArtifactRefs ? { currentArtifactRefs: derived.currentArtifactRefs } : {}),
		...(existing.currentArtifactRefs && !derived.currentArtifactRefs ? { currentArtifactRefs: existing.currentArtifactRefs } : {}),
		...(derived.summary ? { summary: derived.summary } : existing.summary ? { summary: existing.summary } : {}),
		...(derived.updatedAt ? { updatedAt: derived.updatedAt } : existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
	};
	const meta = {
		version: 1,
		...(workspace.meta || {}),
	} as RlmWorkspaceMeta;
	if (workspace.activeContext.currentPlan) meta.activePlanRef = "globalThis.workspace.activeContext.currentPlan";
	else delete meta.activePlanRef;
	if (workspace.activeContext.currentArtifactRefs?.length) meta.activeArtifactRefs = [...workspace.activeContext.currentArtifactRefs];
	else delete meta.activeArtifactRefs;
	workspace.meta = meta;
	return workspace;
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
	return refreshWorkspaceProjection(workspace);
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
	return refreshWorkspaceProjection(workspace);
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

export function buildWorkspaceWorkingSetSummary(workspaceValue: unknown): string | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	const workspace = ensureWorkspaceShape(workspaceValue);
	const active = workspace.activeContext;
	if (!active) return undefined;
	return active.summary;
}

const DEFAULT_RETENTION_LEASE_TURNS = 2;

function buildRetentionConsolidationRef(summary: string | undefined): RlmConsolidationRef {
	return {
		kind: "workspace-path",
		ref: "globalThis.workspace.activeContext",
		...(summary ? { summary } : {}),
	};
}

function buildLeaseId(input: { source: "assistant" | "tool"; sourceName?: string; turnIndex: number; messageFingerprint: string }): string {
	return [input.source, input.sourceName ?? "assistant", input.turnIndex, input.messageFingerprint].join(":");
}

function refreshRetentionLeases(leases: RlmLease[] | undefined, latestTurnIndex: number, now: string): RlmLease[] {
	return (leases ?? [])
		.map((lease) => {
			if (lease.status !== "consolidated" || typeof lease.expiresAfterTurns !== "number") return lease;
			if (latestTurnIndex - lease.turnIndex < lease.expiresAfterTurns) return lease;
			return {
				...lease,
				status: "expired",
				updatedAt: now,
			} as RlmLease;
		})
		.slice(-MAX_RETENTION_LEASES);
}

function consolidateLeases(
	leases: RlmLease[] | undefined,
	latestTurnIndex: number,
	consolidatedTo: RlmConsolidationRef[] | undefined,
	expiresAfterTurns: number,
	now: string,
): RlmLease[] {
	return (leases ?? []).map((lease) => {
		if (lease.status !== "live") return lease;
		if (lease.turnIndex > latestTurnIndex) return lease;
		return {
			...lease,
			status: "consolidated",
			consolidatedTo: consolidatedTo ?? lease.consolidatedTo,
			expiresAfterTurns: lease.expiresAfterTurns ?? expiresAfterTurns,
			updatedAt: now,
		} as RlmLease;
	});
}

function fingerprintRetentionMetrics(metrics: RlmRetentionMetrics): string {
	return [metrics.keptMessages, metrics.prunedMessages, metrics.placeholderMessages, metrics.retainedTurns, metrics.prunedTurns, metrics.activeContextSummary ?? ""].join(":");
}

export function recordRetentionLease(
	workspaceValue: unknown,
	input: {
		source: "assistant" | "tool";
		sourceName?: string;
		turnIndex: number;
		messageFingerprint: string;
		expiresAfterTurns?: number;
		consolidatedTo?: RlmConsolidationRef[];
	},
): RlmWorkspace | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	const workspace = ensureWorkspaceShape(structuredClone(workspaceValue));
	const now = new Date().toISOString();
	const retention = workspace.retention ?? {};
	const id = buildLeaseId(input);
	const existing = retention.leases?.some((lease) => lease.id === id);
	if (existing) return workspace;
	const lease: RlmLease = {
		id,
		source: input.source,
		sourceName: input.sourceName,
		turnIndex: input.turnIndex,
		messageFingerprint: input.messageFingerprint,
		status: "live",
		consolidatedTo: input.consolidatedTo,
		expiresAfterTurns: input.expiresAfterTurns,
		createdAt: now,
		updatedAt: now,
	};
	workspace.retention = {
		...retention,
		leases: [...(retention.leases ?? []).filter((lease) => lease.id !== id), lease].slice(-MAX_RETENTION_LEASES),
	};
	return workspace;
}

export function recordRetentionMetrics(
	workspaceValue: unknown,
	latestMetrics: RlmRetentionMetrics,
	latestTurnIndex: number,
	policy?: Pick<RlmRetentionPolicy, "expireConsolidatedAfterTurns" | "keepLatestSurfaceSummary" >,
): RlmWorkspace | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	const workspace = ensureWorkspaceShape(structuredClone(workspaceValue));
	const now = new Date().toISOString();
	const currentRetention = workspace.retention ?? {};
	const keepLatestSurfaceSummary = policy?.keepLatestSurfaceSummary ?? true;
	const summary = latestMetrics.activeContextSummary ?? (keepLatestSurfaceSummary ? currentRetention.latestSurfaceSummary : undefined);
	const expiresAfterTurns = policy?.expireConsolidatedAfterTurns ?? DEFAULT_RETENTION_LEASE_TURNS;
	const consolidationRefs = summary ? [buildRetentionConsolidationRef(summary)] : undefined;
	const lease: RlmLease = {
		id: `retention-${latestTurnIndex}-${latestMetrics.keptMessages}-${latestMetrics.prunedMessages}`,
		source: "assistant",
		sourceName: "rlm-retention",
		turnIndex: latestTurnIndex,
		messageFingerprint: `${latestMetrics.keptMessages}:${latestMetrics.prunedMessages}:${latestMetrics.placeholderMessages}:${latestMetrics.retainedTurns}:${latestMetrics.prunedTurns}`,
		status: "consolidated",
		consolidatedTo: consolidationRefs,
		expiresAfterTurns,
		createdAt: now,
		updatedAt: now,
	};
	const currentFingerprint = currentRetention.latestMetrics ? fingerprintRetentionMetrics(currentRetention.latestMetrics) : undefined;
	const nextFingerprint = fingerprintRetentionMetrics(latestMetrics);
	const existingLease = currentRetention.leases?.some((item) => item.id === lease.id) ?? false;
	if (currentRetention.latestTurnIndex === latestTurnIndex && currentFingerprint === nextFingerprint && existingLease) return workspace;
	const consolidatedLeases = consolidateLeases(currentRetention.leases, latestTurnIndex, consolidationRefs, expiresAfterTurns, now);
	const refreshedLeases = refreshRetentionLeases(consolidatedLeases, latestTurnIndex, now).filter((item) => item.id !== lease.id);
	workspace.retention = {
		...currentRetention,
		latestMetrics,
		latestTurnIndex,
		...(summary ? { latestSurfaceSummary: summary } : {}),
		leases: [...refreshedLeases, lease].slice(-MAX_RETENTION_LEASES),
	};
	return workspace;
}

export function buildWorkspacePointerHints(workspaceValue: unknown): string | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	ensureWorkspaceShape(workspaceValue);
	return [
		"- Inspect globalThis.workspace.activeContext first.",
		"- Durable notebook: globalThis.workspace",
		"- Parent-provided local state: globalThis.parentState",
	].join("\n");
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
		general: ["goal", "plan", "activeContext", "files", "findings", "partialOutputs", "childArtifacts"],
		scout: ["activeContext", "files", "findings", "childArtifacts", "openQuestions"],
		planner: ["activeContext", "goal", "plan", "openQuestions", "partialOutputs", "childArtifacts"],
		worker: ["activeContext", "files", "findings", "partialOutputs", "childArtifacts"],
		reviewer: ["activeContext", "findings", "partialOutputs", "childArtifacts", "openQuestions"],
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
