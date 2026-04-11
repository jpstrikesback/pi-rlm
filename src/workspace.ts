import type {
	LlmQueryRole,
	RlmActiveContext,
	RlmArtifactIndex,
	RlmArtifactSummary,
	RlmChildArtifact,
	RlmCompiledContext,
	RlmCompiledContextHandle,
	RlmCompiledExactValue,
	RlmConsolidationRef,
	RlmEvidenceCheckpoint,
	RlmEvidenceItem,
	RlmEvidenceSourceRef,
	RlmEvidenceStatus,
	RlmPendingEvidenceBurst,
	RlmQueryMode,
	RlmLease,
	RlmRetentionMetrics,
	RlmRetentionPolicy,
	RlmValueManifest,
	RlmWorkspaceCommitPatch,
	RlmWorkspaceCommitResult,
	RlmWorkspaceCoordination,
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
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_CHECKPOINTS = 16;
const WORKSPACE_RUNTIME_PATH = "globalThis.workspace" as const;
const PARENT_STATE_RUNTIME_PATH = "globalThis.parentState" as const;
const INPUT_RUNTIME_PATH = "globalThis.input" as const;
const SUPPORTED_WORKSPACE_COMMIT_KEYS = new Set(["goal", "plan", "files", "findings", "openQuestions", "partialOutputs"]);

export type RlmWorkspaceContextBrief = {
	activeContextSummary?: string;
	selectedEvidenceItems: RlmEvidenceItem[];
	selectedEvidenceCheckpoints: RlmEvidenceCheckpoint[];
	artifactRefs: string[];
	compactState: string[];
};

export type RlmWorkspaceContextBriefOptions = {
	prompt?: string;
	evidenceItemLimit?: number;
	evidenceCheckpointLimit?: number;
	artifactRefLimit?: number;
};

export function buildWorkspaceContextBrief(
	workspaceValue: unknown,
	options: RlmWorkspaceContextBriefOptions = {},
): RlmWorkspaceContextBrief {
	if (!workspaceValue || typeof workspaceValue !== "object" || Array.isArray(workspaceValue)) {
		return {
			selectedEvidenceItems: [],
			selectedEvidenceCheckpoints: [],
			artifactRefs: [],
			compactState: ["No persistent workspace bound for this context."],
		};
	}
	const workspace = ensureWorkspaceShape(workspaceValue);
	const activeContextSummary = buildWorkspaceWorkingSetSummary(workspace);
	const prompt = options.prompt ?? activeContextSummary;
	const selectedEvidenceItems = selectRelevantEvidenceItems(workspace, {
		prompt,
		limit: options.evidenceItemLimit ?? 4,
		statuses: ["pending", "committed"],
	});
	const selectedEvidenceCheckpoints = selectRelevantEvidenceCheckpoints(workspace, {
		prompt,
		limit: options.evidenceCheckpointLimit ?? 3,
		itemIds: selectedEvidenceItems.map((item) => item.id),
	});
	const artifactRefs = Array.from(
		new Set<string>([
			...(workspace.meta?.activeArtifactRefs ?? []),
			...(workspace.activeContext?.currentArtifactRefs ?? []),
			...(workspace.artifactIndex?.recentIds ?? []),
		]),
	).slice(0, options.artifactRefLimit ?? 8);

	const coordination = workspace.meta?.coordination;
	return {
		activeContextSummary,
		selectedEvidenceItems,
		selectedEvidenceCheckpoints,
		artifactRefs,
		compactState: [
			`Plan: ${workspace.plan?.length ?? 0}`,
			`Open questions: ${workspace.openQuestions?.length ?? 0}`,
			`Findings: ${workspace.findings?.length ?? 0}`,
			`Artifacts: ${workspace.childArtifacts?.length ?? 0}`,
			`Evidence items: ${workspace.evidence?.items?.length ?? 0}`,
			`Evidence checkpoints: ${workspace.evidence?.checkpoints?.length ?? 0}`,
			`Pending consolidation: ${coordination?.pendingConsolidation === true ? "yes" : "no"}`,
		],
	};
}

function cloneIfPossible<T>(value: T): T | undefined {
	try {
		return structuredClone(value);
	} catch {
		return undefined;
	}
}

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

function dedupeSourceRefs(value: RlmEvidenceSourceRef[] | undefined): RlmEvidenceSourceRef[] | undefined {
	if (!value || value.length === 0) return undefined;
	const seen = new Set<string>();
	const next: RlmEvidenceSourceRef[] = [];
	for (const item of value) {
		const key = `${item.kind}:${item.ref}`;
		if (seen.has(key)) continue;
		seen.add(key);
		next.push(item);
	}
	return next.length > 0 ? next : undefined;
}

function normalizeEvidenceItems(value: unknown): RlmEvidenceItem[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.summary !== "string") return [];
		const kind = item.kind === "commit" ? "commit" : "tool";
		const toolName = typeof item.toolName === "string" ? item.toolName : undefined;
		const toolNames = normalizeStringList(item.toolNames) ?? (toolName ? [toolName] : undefined);
		const files = normalizeStringList(item.files);
		const refs = normalizeStringList(item.refs) ?? files;
		const sourceRefs = Array.isArray(item.sourceRefs)
			? dedupeSourceRefs(
				item.sourceRefs.flatMap((ref): RlmEvidenceSourceRef[] => {
					if (!isRecord(ref) || typeof ref.kind !== "string" || typeof ref.ref !== "string") return [];
					if (ref.kind !== "path" && ref.kind !== "tool" && ref.kind !== "workspace-path" && ref.kind !== "artifact-id" && ref.kind !== "evidence-id") return [];
					return [{ kind: ref.kind, ref: ref.ref }];
				}),
			)
			: dedupeSourceRefs([
				...(toolNames ?? []).map((name): RlmEvidenceSourceRef => ({ kind: "tool", ref: name })),
				...(refs ?? []).map((ref): RlmEvidenceSourceRef => ({ kind: "path", ref })),
			]);
		const committed = item.committed === true || item.status === "committed" || kind === "commit";
		const status = item.status === "committed" || item.status === "pending"
			? item.status
			: committed ? "committed" : "pending";
		const trust = item.trust === "derived" ? "derived" : "grounded";
		const changedKeys = normalizeStringList(item.changedKeys);
		const consolidatedIds = normalizeStringList(item.consolidatedIds);
		const salience = typeof item.salience === "number" && Number.isFinite(item.salience)
			? item.salience
			: Math.max(1, Math.min(10, (files?.length ?? 0) + (toolNames?.length ?? 0) + (committed ? 2 : 0) + (changedKeys?.length ?? 0)));
		return [{
			id: item.id,
			turnIndex: typeof item.turnIndex === "number" && Number.isFinite(item.turnIndex) ? item.turnIndex : 0,
			kind,
			summary: item.summary,
			...(typeof item.burstId === "string" ? { burstId: item.burstId } : {}),
			...(toolName ? { toolName } : {}),
			...(toolNames ? { toolNames } : {}),
			...(files ? { files } : {}),
			...(refs ? { refs } : {}),
			...(sourceRefs ? { sourceRefs } : {}),
			...(changedKeys ? { changedKeys } : {}),
			...(consolidatedIds ? { consolidatedIds } : {}),
			trust,
			salience,
			status,
			committed,
			createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
			...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
		} satisfies RlmEvidenceItem];
	});
}

function normalizeEvidenceCheckpoints(value: unknown): RlmEvidenceCheckpoint[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.summary !== "string") return [];
		const itemIds = normalizeStringList(item.itemIds) ?? [];
		const files = normalizeStringList(item.files);
		const refs = normalizeStringList(item.refs) ?? files;
		const trust = item.trust === "derived" ? "derived" : "grounded";
		const salience = typeof item.salience === "number" && Number.isFinite(item.salience)
			? item.salience
			: Math.max(1, Math.min(10, (files?.length ?? 0) + (itemIds.length > 0 ? 2 : 0)));
		return [{
			id: item.id,
			turnIndex: typeof item.turnIndex === "number" && Number.isFinite(item.turnIndex) ? item.turnIndex : 0,
			summary: item.summary,
			itemIds,
			...(files ? { files } : {}),
			...(refs ? { refs } : {}),
			trust,
			salience,
			createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
			...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
		} satisfies RlmEvidenceCheckpoint];
	});
}

function appendUniqueCompactStrings(existing: string[] | undefined, incoming: string[] | undefined, limit = 6): string[] | undefined {
	const next = Array.from(new Set([...(existing ?? []), ...(incoming ?? [])].filter((item) => typeof item === "string" && item.trim().length > 0)));
	return next.length > 0 ? next.slice(0, limit) : undefined;
}

function looksPathBearingToken(token: string): boolean {
	return /(?:\/|\.[a-z0-9]+$)/i.test(token);
}

function extractPathTokensFromText(value: string): string[] {
	const matches = value.match(/(?:\.{1,2}\/)?[A-Za-z0-9_@.~:-]+(?:\/[A-Za-z0-9_@.~:-]+)+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|txt|yml|yaml)/g) ?? [];
	return Array.from(new Set(matches
		.map((item) => item.replace(/^[`'"(\[]+|[`'"),\]]+$/g, "").trim())
		.map((item) => item.replace(/:(\d+)(?::\d+)?$/g, ""))
		.filter((item) => item.length > 0 && looksPathBearingToken(item))));
}

function collectPathCandidates(value: unknown, limit = 8, depth = 0, seen = new WeakSet<object>()): string[] {
	if (limit <= 0 || value === null || value === undefined) return [];
	if (typeof value === "string") return extractPathTokensFromText(value).slice(0, limit);
	if (typeof value !== "object") return [];
	if (seen.has(value)) return [];
	seen.add(value);
	if (depth >= 3) return [];
	const out: string[] = [];
	const push = (items: string[]) => {
		for (const item of items) {
			if (out.includes(item)) continue;
			out.push(item);
			if (out.length >= limit) break;
		}
	};
	if (Array.isArray(value)) {
		for (const item of value) {
			push(collectPathCandidates(item, limit - out.length, depth + 1, seen));
			if (out.length >= limit) break;
		}
		return out;
	}
	for (const [key, inner] of Object.entries(value)) {
		if (looksPathBearingToken(key)) push([key]);
		push(collectPathCandidates(inner, limit - out.length, depth + 1, seen));
		if (out.length >= limit) break;
	}
	return out;
}

function buildToolEvidenceSummary(toolName: string, args: unknown, result: unknown, isError?: boolean): string {
	const files = appendUniqueCompactStrings(collectPathCandidates(args, 4), collectPathCandidates(result, 4), 4);
	const prefix = isError ? `${toolName} error` : toolName;
	if (files?.length) return `${prefix}: ${files.join(", ")}`;
	if (toolName === "bash") {
		const command = isRecord(args) && typeof args.command === "string" ? args.command.trim().replace(/\s+/g, " ").slice(0, 80) : undefined;
		if (command) return `bash: ${command}`;
	}
	return isError ? `${toolName}: error result` : `${toolName}: completed`;
}

function buildToolObservationSummary(toolNames: string[], files: string[] | undefined, hasError?: boolean): string {
	const toolLabel = toolNames.length > 0 ? toolNames.join(", ") : "tool";
	const prefix = hasError ? `tool burst error (${toolLabel})` : `tool burst (${toolLabel})`;
	if (files?.length) return `${prefix}: ${files.join(", ")}`;
	return prefix;
}

function buildCommitEvidenceSummary(changedKeys: string[], files: string[] | undefined, consolidatedIds: string[] | undefined): string {
	const changed = changedKeys.length > 0 ? changedKeys.join(", ") : "no-op";
	const consolidated = consolidatedIds?.length ? ` | consolidated observations: ${consolidatedIds.length}` : "";
	if (files?.length) return `workspace.commit: ${changed} | files: ${files.join(", ")}${consolidated}`;
	return `workspace.commit: ${changed}${consolidated}`;
}

function buildEvidenceSourceRefs(input: {
	toolNames?: string[];
	refs?: string[];
	workspaceRefs?: string[];
	artifactRefs?: string[];
	evidenceRefs?: string[];
}): RlmEvidenceSourceRef[] | undefined {
	return dedupeSourceRefs([
		...(input.toolNames ?? []).map((ref): RlmEvidenceSourceRef => ({ kind: "tool", ref })),
		...(input.refs ?? []).map((ref): RlmEvidenceSourceRef => ({ kind: "path", ref })),
		...(input.workspaceRefs ?? []).map((ref): RlmEvidenceSourceRef => ({ kind: "workspace-path", ref })),
		...(input.artifactRefs ?? []).map((ref): RlmEvidenceSourceRef => ({ kind: "artifact-id", ref })),
		...(input.evidenceRefs ?? []).map((ref): RlmEvidenceSourceRef => ({ kind: "evidence-id", ref })),
	]);
}

function computeEvidenceSalience(input: {
	files?: string[];
	toolNames?: string[];
	changedKeys?: string[];
	committed?: boolean;
	hasError?: boolean;
}): number {
	const score =
		(input.files?.length ?? 0) +
		(input.toolNames?.length ?? 0) +
		(input.changedKeys?.length ?? 0) +
		(input.committed ? 2 : 0) +
		(input.hasError ? 2 : 0);
	return Math.max(1, Math.min(10, score));
}

function hasFileOverlap(left: string[] | undefined, right: string[] | undefined): boolean {
	if (!left?.length || !right?.length) return false;
	const rightSet = new Set(right);
	return left.some((item) => rightSet.has(item));
}

function buildEvidenceBurstId(turnIndex: number, index: number): string {
	return `turn:${turnIndex}:burst:${index}`;
}

function buildEvidenceCheckpointSummary(itemIds: string[], changedKeys: string[], files: string[] | undefined): string {
	const changed = changedKeys.length > 0 ? `changed ${changedKeys.join(", ")}` : "committed observations";
	if (files?.length) return `checkpoint: ${changed} | files: ${files.join(", ")} | items: ${itemIds.length}`;
	return `checkpoint: ${changed} | items: ${itemIds.length}`;
}

function buildPendingBurstSummary(toolNames: string[] | undefined, files: string[] | undefined, turnIndex: number): string {
	const toolLabel = toolNames?.length ? toolNames.join(", ") : "tool";
	const fileLabel = files?.length ? ` on ${files.join(", ")}` : "";
	return `T${turnIndex + 1} pending burst (${toolLabel})${fileLabel}`;
}

function requiresCommitForEvidenceItem(item: RlmEvidenceItem): boolean {
	if (item.kind !== "tool") return false;
	if ((item.files?.length ?? 0) > 0) return true;
	if ((item.toolNames?.length ?? (item.toolName ? 1 : 0)) > 1) return true;
	if ((item.salience ?? 0) >= 2) return true;
	return /error/i.test(item.summary);
}

function buildPendingEvidenceBursts(items: RlmEvidenceItem[]): RlmPendingEvidenceBurst[] {
	const groups = new Map<string, RlmEvidenceItem[]>();
	for (const item of items) {
		if (item.kind !== "tool") continue;
		if ((item.status ?? (item.committed ? "committed" : "pending")) !== "pending") continue;
		const key = item.burstId ?? item.id;
		const existing = groups.get(key);
		if (existing) existing.push(item);
		else groups.set(key, [item]);
	}
	return Array.from(groups.entries())
		.map(([id, burstItems]) => {
			const first = burstItems[0];
			const toolNames = appendUniqueCompactStrings(
				undefined,
				burstItems.flatMap((item) => item.toolNames ?? (item.toolName ? [item.toolName] : [])),
				6,
			);
			const files = appendUniqueCompactStrings(undefined, burstItems.flatMap((item) => item.files ?? []), 6);
			const salience = Math.max(...burstItems.map((item) => item.salience ?? 1));
			const requiresCommit = burstItems.some((item) => requiresCommitForEvidenceItem(item));
			return {
				id,
				turnIndex: first.turnIndex,
				itemIds: burstItems.map((item) => item.id),
				...(toolNames ? { toolNames } : {}),
				...(files ? { files } : {}),
				summary: buildPendingBurstSummary(toolNames, files, first.turnIndex),
				salience,
				requiresCommit,
				createdAt: first.createdAt,
				updatedAt: burstItems.map((item) => item.updatedAt).filter((value): value is string => typeof value === "string").at(-1),
			} satisfies RlmPendingEvidenceBurst;
		})
		.sort((left, right) => (right.turnIndex - left.turnIndex) || (right.salience - left.salience) || left.id.localeCompare(right.id));
}

function clearLeafBurstProtocolState(coordination: RlmWorkspaceCoordination): void {
	delete coordination.pendingBurstIds;
	delete coordination.meaningfulPendingBurstIds;
	delete coordination.lastCommitConsolidatedIds;
	delete coordination.lastCommitConsolidatedBurstIds;
	delete coordination.lastCommitSatisfiedProtocol;
}

function refreshEvidenceCoordination(workspace: RlmWorkspace): RlmWorkspace {
	workspace.meta = {
		version: 1,
		...(workspace.meta || {}),
	};
	const existing = normalizeCoordination(workspace.meta.coordination) ?? {};
	if (!isLeafBurstProtocolEnabled(workspace)) {
		clearLeafBurstProtocolState(existing);
		if (Object.keys(existing).length > 0) workspace.meta.coordination = existing;
		else delete workspace.meta.coordination;
		return workspace;
	}
	const pendingBursts = buildPendingEvidenceBursts(workspace.evidence?.items ?? []);
	const meaningfulPendingBursts = pendingBursts.filter((burst) => burst.requiresCommit);
	const hasEvidenceState =
		(workspace.evidence?.items?.length ?? 0) > 0 ||
		(workspace.evidence?.pendingIds?.length ?? 0) > 0 ||
		!!existing.pendingBurstIds?.length ||
		!!existing.meaningfulPendingBurstIds?.length ||
		typeof existing.pendingConsolidation === "boolean";
	if (hasEvidenceState) {
		existing.pendingConsolidation = meaningfulPendingBursts.length > 0;
		if (pendingBursts.length > 0) existing.pendingBurstIds = pendingBursts.map((burst) => burst.id);
		else delete existing.pendingBurstIds;
		if (meaningfulPendingBursts.length > 0) existing.meaningfulPendingBurstIds = meaningfulPendingBursts.map((burst) => burst.id);
		else delete existing.meaningfulPendingBurstIds;
	}
	if (Object.keys(existing).length > 0) workspace.meta.coordination = existing;
	else delete workspace.meta.coordination;
	return workspace;
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

function normalizeCoordination(value: unknown): RlmWorkspaceCoordination | undefined {
	if (!isRecord(value)) return undefined;
	const next: RlmWorkspaceCoordination = {};
	if (typeof value.hasCommitted === "boolean") next.hasCommitted = value.hasCommitted;
	if (typeof value.pendingConsolidation === "boolean") next.pendingConsolidation = value.pendingConsolidation;
	if (typeof value.lastCommittedTurn === "number" && Number.isFinite(value.lastCommittedTurn)) next.lastCommittedTurn = value.lastCommittedTurn;
	if (typeof value.lastLeafToolTurn === "number" && Number.isFinite(value.lastLeafToolTurn)) next.lastLeafToolTurn = value.lastLeafToolTurn;
	const changedKeys = normalizeStringList(value.lastCommitChangedKeys);
	if (changedKeys) next.lastCommitChangedKeys = changedKeys;
	const pendingBurstIds = normalizeStringList(value.pendingBurstIds);
	if (pendingBurstIds) next.pendingBurstIds = pendingBurstIds;
	const meaningfulPendingBurstIds = normalizeStringList(value.meaningfulPendingBurstIds);
	if (meaningfulPendingBurstIds) next.meaningfulPendingBurstIds = meaningfulPendingBurstIds;
	const lastCommitConsolidatedIds = normalizeStringList(value.lastCommitConsolidatedIds);
	if (lastCommitConsolidatedIds) next.lastCommitConsolidatedIds = lastCommitConsolidatedIds;
	const lastCommitConsolidatedBurstIds = normalizeStringList(value.lastCommitConsolidatedBurstIds);
	if (lastCommitConsolidatedBurstIds) next.lastCommitConsolidatedBurstIds = lastCommitConsolidatedBurstIds;
	if (typeof value.lastCommitSatisfiedProtocol === "boolean") next.lastCommitSatisfiedProtocol = value.lastCommitSatisfiedProtocol;
	return Object.keys(next).length > 0 ? next : undefined;
}

function ensureCoordinationMeta(meta: RlmWorkspaceMeta): RlmWorkspaceCoordination {
	const normalized = normalizeCoordination(meta.coordination) ?? {};
	meta.coordination = normalized;
	return normalized;
}

function isLeafBurstProtocolEnabled(workspace: RlmWorkspace): boolean {
	return workspace.meta?.leafBurstProtocolEnabled !== false;
}

function appendUniqueStrings(existingValue: unknown, incomingValue: unknown): { next?: string[]; changed: boolean } {
	const existing = normalizeStringList(existingValue) ?? [];
	const incoming = normalizeStringList(incomingValue) ?? [];
	if (incoming.length === 0) return { next: existing.length > 0 ? existing : undefined, changed: false };
	const seen = new Set(existing);
	const next = [...existing];
	let changed = false;
	for (const item of incoming) {
		if (seen.has(item)) continue;
		seen.add(item);
		next.push(item);
		changed = true;
	}
	return { next: next.length > 0 ? next : undefined, changed };
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
	workspace.evidence = isRecord(workspace.evidence)
		? {
			...(workspace.evidence as Record<string, unknown>),
			items: normalizeEvidenceItems((workspace.evidence as Record<string, unknown>).items),
			checkpoints: normalizeEvidenceCheckpoints((workspace.evidence as Record<string, unknown>).checkpoints),
			pendingIds: normalizeStringList((workspace.evidence as Record<string, unknown>).pendingIds),
		}
		: { items: [], checkpoints: [] };
	if (!Array.isArray(workspace.evidence.checkpoints)) workspace.evidence.checkpoints = [];
	if (!workspace.evidence.pendingIds || workspace.evidence.pendingIds.length === 0) {
		workspace.evidence.pendingIds = (workspace.evidence.items ?? [])
			.filter((item) => item.status === "pending")
			.map((item) => item.id);
	}
	workspace.meta = isRecord(workspace.meta)
		? ({ version: 1, ...(workspace.meta as Record<string, unknown>) } as RlmWorkspace["meta"])
		: { version: 1 };
	if (workspace.meta) {
		const coordination = normalizeCoordination(workspace.meta.coordination);
		if (coordination) workspace.meta.coordination = coordination;
		else delete workspace.meta.coordination;
	}
	refreshWorkspaceProjection(workspace);
	return refreshEvidenceCoordination(workspace);
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

function normalizeCommitFindings(value: unknown): Array<string | Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	const next: Array<string | Record<string, unknown>> = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim().length > 0) {
			next.push(item);
			continue;
		}
		if (!isRecord(item)) continue;
		const cloned = cloneIfPossible(item);
		if (cloned && isRecord(cloned)) next.push(cloned);
	}
	return next;
}

function normalizeCommitPartialOutputs(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const next: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		if (!key.trim()) continue;
		const cloned = cloneIfPossible(inner);
		if (cloned !== undefined) next[key] = cloned;
	}
	return next;
}

export function commitWorkspacePatch(
	workspaceValue: unknown,
	patchValue: unknown,
	options: { turnIndex?: number; now?: string } = {},
): { workspace: RlmWorkspace; result: RlmWorkspaceCommitResult } {
	const workspace = ensureWorkspaceShape(cloneIfPossible(workspaceValue) ?? workspaceValue);
	const patch = isRecord(patchValue) ? patchValue : {};
	const ignoredKeys = Object.keys(patch).filter((key) => !SUPPORTED_WORKSPACE_COMMIT_KEYS.has(key));
	const changedKeys: string[] = [];

	if (typeof patch.goal === "string" && patch.goal.trim().length > 0) {
		const nextGoal = patch.goal.trim();
		if (workspace.goal !== nextGoal) {
			workspace.goal = nextGoal;
			changedKeys.push("goal");
		}
	} else if ("goal" in patch) {
		ignoredKeys.push("goal");
	}

	if ("plan" in patch) {
		const nextPlan = Array.isArray(patch.plan)
			? patch.plan.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			: undefined;
		if (nextPlan) {
			if (JSON.stringify(workspace.plan ?? []) !== JSON.stringify(nextPlan)) {
				workspace.plan = nextPlan;
				changedKeys.push("plan");
			}
		} else {
			ignoredKeys.push("plan");
		}
	}

	if ("files" in patch) {
		const { next, changed } = appendUniqueStrings(workspace.files, patch.files);
		if (next) workspace.files = next;
		if (changed) changedKeys.push("files");
		else if (!Array.isArray(patch.files)) ignoredKeys.push("files");
	}

	if ("findings" in patch) {
		const nextFindings = normalizeCommitFindings(patch.findings);
		if (nextFindings.length > 0) {
			workspace.findings = [...(workspace.findings ?? []), ...nextFindings];
			changedKeys.push("findings");
		} else {
			ignoredKeys.push("findings");
		}
	}

	if ("openQuestions" in patch) {
		const { next, changed } = appendUniqueStrings(workspace.openQuestions, patch.openQuestions);
		if (next) workspace.openQuestions = next;
		if (changed) changedKeys.push("openQuestions");
		else if (!Array.isArray(patch.openQuestions)) ignoredKeys.push("openQuestions");
	}

	if ("partialOutputs" in patch) {
		const nextOutputs = normalizeCommitPartialOutputs(patch.partialOutputs);
		if (Object.keys(nextOutputs).length > 0) {
			workspace.partialOutputs = {
				...(isRecord(workspace.partialOutputs) ? workspace.partialOutputs : {}),
				...nextOutputs,
			};
			changedKeys.push("partialOutputs");
		} else {
			ignoredKeys.push("partialOutputs");
		}
	}

	workspace.meta = {
		version: 1,
		...(workspace.meta || {}),
		...(options.now ? { updatedAt: options.now } : {}),
	};
	const coordination = ensureCoordinationMeta(workspace.meta);
	coordination.hasCommitted = true;
	if (typeof options.turnIndex === "number" && Number.isFinite(options.turnIndex)) coordination.lastCommittedTurn = options.turnIndex;
	coordination.lastCommitChangedKeys = [...changedKeys];

	refreshWorkspaceProjection(workspace);
	const protocol = applyCommitEvidenceProtocol(workspace, {
		turnIndex: typeof options.turnIndex === "number" && Number.isFinite(options.turnIndex) ? options.turnIndex : 0,
		changedKeys,
		now: options.now,
	});

	return {
		workspace: protocol.workspace,
		result: {
			ok: true,
			changedKeys,
			ignoredKeys: Array.from(new Set(ignoredKeys)),
			activeContextSummary: protocol.workspace.activeContext?.summary,
			planLength: protocol.workspace.plan?.length ?? 0,
			findingCount: protocol.workspace.findings?.length ?? 0,
			...protocol.result,
		},
	};
}

export function recordLeafToolObservation(
	workspaceValue: unknown,
	options: { turnIndex?: number; now?: string } = {},
): RlmWorkspace | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	const workspace = ensureWorkspaceShape(structuredClone(workspaceValue));
	workspace.meta = {
		version: 1,
		...(workspace.meta || {}),
		...(options.now ? { updatedAt: options.now } : {}),
	};
	const coordination = ensureCoordinationMeta(workspace.meta);
	coordination.pendingConsolidation = true;
	if (typeof options.turnIndex === "number" && Number.isFinite(options.turnIndex)) coordination.lastLeafToolTurn = options.turnIndex;
	refreshWorkspaceProjection(workspace);
	return workspace;
}

function appendEvidenceItem(workspace: RlmWorkspace, item: RlmEvidenceItem): RlmWorkspace {
	const current = workspace.evidence?.items ?? [];
	const items = [...current.filter((existing) => existing.id !== item.id), item].slice(-MAX_EVIDENCE_ITEMS);
	workspace.evidence = {
		...(workspace.evidence ?? {}),
		latestTurnIndex: item.turnIndex,
		items,
		checkpoints: workspace.evidence?.checkpoints ?? [],
		pendingIds: items.filter((existing) => existing.status === "pending").map((existing) => existing.id),
	};
	return workspace;
}

function upsertEvidenceItems(workspace: RlmWorkspace, items: RlmEvidenceItem[]): RlmWorkspace {
	const current = workspace.evidence?.items ?? [];
	const byId = new Map<string, RlmEvidenceItem>(current.map((item) => [item.id, item]));
	for (const item of items) byId.set(item.id, item);
	const next = Array.from(byId.values())
		.sort((left, right) => {
			const turnDelta = left.turnIndex - right.turnIndex;
			if (turnDelta !== 0) return turnDelta;
			return left.createdAt.localeCompare(right.createdAt);
		})
		.slice(-MAX_EVIDENCE_ITEMS);
	workspace.evidence = {
		...(workspace.evidence ?? {}),
		latestTurnIndex: next.at(-1)?.turnIndex,
		items: next,
		checkpoints: workspace.evidence?.checkpoints ?? [],
		pendingIds: next.filter((item) => item.status === "pending").map((item) => item.id),
	};
	return workspace;
}

function upsertEvidenceCheckpoints(workspace: RlmWorkspace, checkpoints: RlmEvidenceCheckpoint[]): RlmWorkspace {
	const current = workspace.evidence?.checkpoints ?? [];
	const byId = new Map<string, RlmEvidenceCheckpoint>(current.map((item) => [item.id, item]));
	for (const checkpoint of checkpoints) byId.set(checkpoint.id, checkpoint);
	const next = Array.from(byId.values())
		.sort((left, right) => {
			const turnDelta = left.turnIndex - right.turnIndex;
			if (turnDelta !== 0) return turnDelta;
			return left.createdAt.localeCompare(right.createdAt);
		})
		.slice(-MAX_EVIDENCE_CHECKPOINTS);
	workspace.evidence = {
		...(workspace.evidence ?? {}),
		items: workspace.evidence?.items ?? [],
		checkpoints: next,
		pendingIds: workspace.evidence?.pendingIds ?? [],
		latestTurnIndex: workspace.evidence?.latestTurnIndex,
	};
	return workspace;
}

function mergeToolObservation(existing: RlmEvidenceItem, input: {
	turnIndex: number;
	toolName: string;
	files?: string[];
	now: string;
	isError?: boolean;
}): RlmEvidenceItem {
	const toolNames = appendUniqueCompactStrings(existing.toolNames ?? (existing.toolName ? [existing.toolName] : undefined), [input.toolName], 6) ?? [input.toolName];
	const files = appendUniqueCompactStrings(existing.files, input.files, 6);
	const refs = appendUniqueCompactStrings(existing.refs, files, 6);
	const sourceRefs = buildEvidenceSourceRefs({ toolNames, refs });
	const status = existing.status === "committed" ? "committed" : "pending";
	const committed = status === "committed";
	return {
		...existing,
		toolName: toolNames[0],
		toolNames,
		...(files ? { files } : {}),
		...(refs ? { refs } : {}),
		...(sourceRefs ? { sourceRefs } : {}),
		summary: buildToolObservationSummary(toolNames, files, input.isError),
		trust: "grounded",
		salience: computeEvidenceSalience({ files, toolNames, committed, hasError: input.isError }),
		status,
		committed,
		updatedAt: input.now,
	};
}

export function recordToolEvidence(
	workspaceValue: unknown,
	input: {
		turnIndex: number;
		toolName: string;
		args?: unknown;
		result?: unknown;
		isError?: boolean;
		now?: string;
	},
): RlmWorkspace | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	const workspace = ensureWorkspaceShape(structuredClone(workspaceValue));
	const createdAt = input.now ?? new Date().toISOString();
	const files = appendUniqueCompactStrings(collectPathCandidates(input.args, 6), collectPathCandidates(input.result, 6), 6);
	const currentItems = workspace.evidence?.items ?? [];
	const pendingToolItems = currentItems.filter((item) => item.kind === "tool" && item.turnIndex === input.turnIndex && item.status === "pending");
	const existing = [...pendingToolItems].reverse().find((item) => {
		if (hasFileOverlap(item.files, files)) return true;
		if (!item.files?.length || !files?.length) return true;
		return false;
	});
	if (existing) {
		return refreshEvidenceCoordination(upsertEvidenceItems(workspace, [mergeToolObservation(existing, {
			turnIndex: input.turnIndex,
			toolName: input.toolName,
			files,
			now: createdAt,
			isError: input.isError,
		})]));
	}
	const burstId = buildEvidenceBurstId(input.turnIndex, pendingToolItems.length + 1);
	const toolNames = [input.toolName];
	const refs = files;
	const sourceRefs = buildEvidenceSourceRefs({ toolNames, refs });
	return refreshEvidenceCoordination(appendEvidenceItem(workspace, {
		id: `tool:${input.turnIndex}:${createdAt}`,
		turnIndex: input.turnIndex,
		kind: "tool",
		burstId,
		summary: buildToolObservationSummary(toolNames, files, input.isError) || buildToolEvidenceSummary(input.toolName, input.args, input.result, input.isError),
		toolName: input.toolName,
		toolNames,
		...(files ? { files } : {}),
		...(refs ? { refs } : {}),
		...(sourceRefs ? { sourceRefs } : {}),
		trust: "grounded",
		salience: computeEvidenceSalience({ files, toolNames, committed: false, hasError: input.isError }),
		status: "pending",
		committed: false,
		createdAt,
	}));
}

function applyCommitEvidenceProtocol(
	workspace: RlmWorkspace,
	input: {
		turnIndex: number;
		changedKeys?: string[];
		files?: string[];
		now?: string;
	},
): { workspace: RlmWorkspace; result: Pick<RlmWorkspaceCommitResult, "pendingConsolidation" | "consolidatedEvidenceIds" | "consolidatedBurstIds" | "meaningfulPendingBeforeCommit" | "meaningfulPendingAfterCommit" | "satisfiedProtocol"> } {
	if (!isLeafBurstProtocolEnabled(workspace)) {
		const coordination = ensureCoordinationMeta((workspace.meta = {
			version: 1,
			...(workspace.meta || {}),
			...(input.now ? { updatedAt: input.now } : {}),
		}));
		clearLeafBurstProtocolState(coordination);
		if ((input.changedKeys?.length ?? 0) > 0) coordination.pendingConsolidation = false;
		if (Object.keys(coordination).length === 0) delete workspace.meta.coordination;
		return {
			workspace,
			result: {
				pendingConsolidation: coordination.pendingConsolidation ?? false,
			},
		};
	}
	const createdAt = input.now ?? new Date().toISOString();
	const activeFiles = normalizeStringArray(workspace.activeContext?.relevantFiles, 6);
	const files = appendUniqueCompactStrings(input.files, activeFiles, 6);
	const changedKeys = normalizeStringArray(input.changedKeys, 6) ?? [];
	const pendingBurstsBefore = buildPendingEvidenceBursts(workspace.evidence?.items ?? []);
	const meaningfulPendingBefore = pendingBurstsBefore.filter((burst) => burst.requiresCommit);
	const pendingIds = workspace.evidence?.pendingIds ?? [];
	const pendingItems = (workspace.evidence?.items ?? []).filter((item) => pendingIds.includes(item.id));
	const canConsolidate = changedKeys.length > 0 && pendingItems.length > 0;
	const consolidatedIds = canConsolidate ? pendingItems.map((item) => item.id) : [];
	const consolidatedBurstIds = canConsolidate
		? pendingBurstsBefore.filter((burst) => burst.itemIds.some((id) => consolidatedIds.includes(id))).map((burst) => burst.id)
		: [];
	const updatedPendingItems = canConsolidate
		? pendingItems.map((item) => ({
			...item,
			status: "committed" as const,
			committed: true,
			updatedAt: createdAt,
			salience: computeEvidenceSalience({
				files: item.files,
				toolNames: item.toolNames ?? (item.toolName ? [item.toolName] : undefined),
				changedKeys: item.changedKeys,
				committed: true,
			}),
		}))
		: [];
	const refs = files;
	const sourceRefs = buildEvidenceSourceRefs({ refs: files, evidenceRefs: consolidatedIds });
	const summary = buildCommitEvidenceSummary(changedKeys, files, consolidatedIds);
	const commitItem: RlmEvidenceItem = {
		id: `commit:${input.turnIndex}:${createdAt}:${changedKeys.join("+") || "noop"}`,
		turnIndex: input.turnIndex,
		kind: "commit",
		summary,
		...(files ? { files } : {}),
		...(refs ? { refs } : {}),
		...(sourceRefs ? { sourceRefs } : {}),
		...(changedKeys.length > 0 ? { changedKeys } : {}),
		...(consolidatedIds.length > 0 ? { consolidatedIds } : {}),
		trust: "grounded",
		salience: computeEvidenceSalience({ files, changedKeys, committed: true }),
		status: "committed",
		committed: true,
		createdAt,
		updatedAt: createdAt,
	};
	let nextWorkspace = upsertEvidenceItems(workspace, [...updatedPendingItems, commitItem]);
	if (consolidatedIds.length > 0) {
		const checkpoint: RlmEvidenceCheckpoint = {
			id: `checkpoint:${input.turnIndex}:${createdAt}`,
			turnIndex: input.turnIndex,
			summary: buildEvidenceCheckpointSummary(consolidatedIds, changedKeys, files),
			itemIds: consolidatedIds,
			...(files ? { files } : {}),
			...(files ? { refs: files } : {}),
			trust: "grounded",
			salience: Math.max(1, Math.min(10, (commitItem.salience ?? 1) + 1)),
			createdAt,
			updatedAt: createdAt,
		};
		nextWorkspace = upsertEvidenceCheckpoints(nextWorkspace, [checkpoint]);
	}
	nextWorkspace = refreshEvidenceCoordination(nextWorkspace);
	nextWorkspace.meta = {
		version: 1,
		...(nextWorkspace.meta || {}),
		updatedAt: createdAt,
	};
	const coordination = ensureCoordinationMeta(nextWorkspace.meta);
	coordination.lastCommitConsolidatedIds = consolidatedIds.length > 0 ? [...consolidatedIds] : [];
	coordination.lastCommitConsolidatedBurstIds = consolidatedBurstIds.length > 0 ? [...consolidatedBurstIds] : [];
	const meaningfulPendingAfter = buildPendingEvidenceBursts(nextWorkspace.evidence?.items ?? []).filter((burst) => burst.requiresCommit);
	const satisfiedProtocol = meaningfulPendingBefore.length === 0 || (canConsolidate && meaningfulPendingAfter.length === 0);
	coordination.lastCommitSatisfiedProtocol = satisfiedProtocol;
	return {
		workspace: nextWorkspace,
		result: {
			pendingConsolidation: ensureCoordinationMeta(nextWorkspace.meta).pendingConsolidation ?? false,
			...(consolidatedIds.length > 0 ? { consolidatedEvidenceIds: consolidatedIds } : {}),
			...(consolidatedBurstIds.length > 0 ? { consolidatedBurstIds } : {}),
			meaningfulPendingBeforeCommit: meaningfulPendingBefore.length,
			meaningfulPendingAfterCommit: meaningfulPendingAfter.length,
			satisfiedProtocol,
		},
	};
}

export function recordCommitEvidence(
	workspaceValue: unknown,
	input: {
		turnIndex: number;
		changedKeys?: string[];
		files?: string[];
		now?: string;
	},
): RlmWorkspace | undefined {
	if (!isRecord(workspaceValue)) return undefined;
	const workspace = ensureWorkspaceShape(structuredClone(workspaceValue));
	return applyCommitEvidenceProtocol(workspace, input).workspace;
}

export function selectPendingEvidenceBursts(
	workspaceValue: unknown,
	options: { meaningfulOnly?: boolean; limit?: number } = {},
): RlmPendingEvidenceBurst[] {
	if (!isRecord(workspaceValue)) return [];
	const workspace = ensureWorkspaceShape(workspaceValue);
	if (!isLeafBurstProtocolEnabled(workspace)) return [];
	const pending = buildPendingEvidenceBursts(workspace.evidence?.items ?? []);
	const filtered = options.meaningfulOnly ? pending.filter((burst) => burst.requiresCommit) : pending;
	return filtered.slice(0, options.limit ?? filtered.length);
}

export function hasMeaningfulPendingEvidenceBursts(workspaceValue: unknown): boolean {
	return selectPendingEvidenceBursts(workspaceValue, { meaningfulOnly: true, limit: 1 }).length > 0;
}

export function hasCommittedWorkspaceState(workspaceValue: unknown): boolean {
	if (!isRecord(workspaceValue)) return false;
	const workspace = ensureWorkspaceShape(workspaceValue);
	return workspace.meta?.coordination?.hasCommitted === true;
}

export function hasPendingWorkspaceConsolidation(workspaceValue: unknown): boolean {
	if (!isRecord(workspaceValue)) return false;
	const workspace = refreshEvidenceCoordination(ensureWorkspaceShape(workspaceValue));
	return workspace.meta?.coordination?.pendingConsolidation === true;
}

export function shouldUseCommittedRetentionPolicy(workspaceValue: unknown): boolean {
	return hasCommittedWorkspaceState(workspaceValue) && !hasPendingWorkspaceConsolidation(workspaceValue);
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
		"- Task snapshot: globalThis.context",
		"- Deterministic compiled working set: globalThis.context.compiledContext",
		"- Inspect globalThis.workspace.activeContext first.",
		"- Durable notebook: globalThis.workspace",
		"- Recent history metadata only: globalThis.history",
		"- Parent-provided local state: globalThis.parentState",
		"- Input alias: globalThis.input",
	].join("\n");
}

function tokenizePrompt(prompt: string): string[] {
	return Array.from(new Set(prompt.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])).slice(0, 24);
}

function evidenceTextScore(tokens: string[], values: string[]): number {
	let score = 0;
	const haystacks = values.map((value) => value.toLowerCase());
	for (const token of tokens) {
		if (haystacks.some((value) => value.includes(token))) score += 3;
	}
	return score;
}

function evidenceItemScore(item: RlmEvidenceItem, tokens: string[], preferredTurnIndexes?: Set<number>): number {
	let score = (item.salience ?? 1) + (item.committed ? 1 : 0);
	score += evidenceTextScore(tokens, [item.summary, ...(item.files ?? []), ...(item.toolNames ?? []), ...(item.refs ?? [])]);
	if (preferredTurnIndexes?.has(item.turnIndex)) score += 4;
	return score;
}

function evidenceCheckpointScore(item: RlmEvidenceCheckpoint, tokens: string[], preferredItemIds?: Set<string>): number {
	let score = item.salience ?? 1;
	score += evidenceTextScore(tokens, [item.summary, ...(item.files ?? []), ...(item.refs ?? [])]);
	if (preferredItemIds && item.itemIds.some((id) => preferredItemIds.has(id))) score += 4;
	return score;
}

export function selectRelevantEvidenceItems(
	workspaceValue: unknown,
	options: {
		prompt?: string;
		turnIndexes?: number[];
		limit?: number;
		statuses?: RlmEvidenceStatus[];
	} = {},
): RlmEvidenceItem[] {
	if (!isRecord(workspaceValue)) return [];
	const workspace = ensureWorkspaceShape(workspaceValue);
	const tokens = tokenizePrompt(options.prompt ?? workspace.activeContext?.summary ?? "");
	const preferredTurnIndexes = options.turnIndexes?.length ? new Set(options.turnIndexes) : undefined;
	const allowedStatuses = options.statuses?.length ? new Set(options.statuses) : undefined;
	const items = (workspace.evidence?.items ?? []).filter((item) => !allowedStatuses || allowedStatuses.has(item.status ?? (item.committed ? "committed" : "pending")));
	const ranked = items
		.map((item, index) => ({ item, index, score: evidenceItemScore(item, tokens, preferredTurnIndexes) }))
		.sort((a, b) => (b.score - a.score) || (b.item.turnIndex - a.item.turnIndex) || (b.index - a.index))
		.map((entry) => entry.item);
	return ranked.slice(0, options.limit ?? 4);
}

export function selectRelevantEvidenceCheckpoints(
	workspaceValue: unknown,
	options: {
		prompt?: string;
		itemIds?: string[];
		limit?: number;
	} = {},
): RlmEvidenceCheckpoint[] {
	if (!isRecord(workspaceValue)) return [];
	const workspace = ensureWorkspaceShape(workspaceValue);
	const tokens = tokenizePrompt(options.prompt ?? workspace.activeContext?.summary ?? "");
	const preferredItemIds = options.itemIds?.length ? new Set(options.itemIds) : undefined;
	const checkpoints = workspace.evidence?.checkpoints ?? [];
	const ranked = checkpoints
		.map((item, index) => ({ item, index, score: evidenceCheckpointScore(item, tokens, preferredItemIds) }))
		.sort((a, b) => (b.score - a.score) || (b.item.turnIndex - a.item.turnIndex) || (b.index - a.index))
		.map((entry) => entry.item);
	return ranked.slice(0, options.limit ?? 3);
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

function describeManifestValue(value: RlmValueManifest): string {
	const details = [value.type];
	if (typeof value.length === "number") details.push(`${value.length}`);
	if (typeof value.keyCount === "number") details.push(`${value.keyCount} keys`);
	if (Array.isArray(value.keys) && value.keys.length > 0) details.push(`keys ${value.keys.join(", ")}`);
	return `${value.path} · ${details.join(" · ")}`;
}

function collectExactStringLeaves(
	value: unknown,
	path: string,
	depth = 0,
	maxDepth = 2,
): Array<{ path: string; value: string }> {
	if (depth > maxDepth || value === null || value === undefined) return [];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [{ path, value: trimmed }] : [];
	}
	if (typeof value !== "object") return [];
	if (Array.isArray(value)) {
		return value.slice(0, 4).flatMap((item, index) => collectExactStringLeaves(item, `${path}[${index}]`, depth + 1, maxDepth));
	}
	return Object.entries(value)
		.slice(0, 8)
		.flatMap(([key, inner]) => collectExactStringLeaves(inner, `${path}.${key}`, depth + 1, maxDepth));
}

function selectExactContextValues(input: {
	workspace?: RlmWorkspace;
	parentState?: Record<string, unknown>;
	artifacts?: RlmArtifactSummary[];
	prompt?: string;
	limit?: number;
	maxChars?: number;
}): RlmCompiledExactValue[] {
	const tokens = tokenizePrompt(input.prompt ?? input.workspace?.activeContext?.summary ?? "");
	if (tokens.length === 0) return [];
	const candidates: RlmCompiledExactValue[] = [];
	const push = (path: string, reason: string, rawValue: string | undefined) => {
		const value = rawValue?.trim();
		if (!value) return;
		const score = evidenceTextScore(tokens, [path, reason, value]);
		if (score <= 0) return;
		const clipped = value.length > (input.maxChars ?? 220) ? `${value.slice(0, (input.maxChars ?? 220) - 1)}…` : value;
		candidates.push({ path, reason, value: clipped });
	};

	for (const item of input.workspace?.findings ?? []) {
		if (typeof item === "string") push(`${WORKSPACE_RUNTIME_PATH}.findings`, "workspace finding", item);
	}
	for (const item of collectExactStringLeaves(input.workspace?.partialOutputs, `${WORKSPACE_RUNTIME_PATH}.partialOutputs`)) {
		push(item.path, "workspace partial output", item.value);
	}
	for (const item of collectExactStringLeaves(input.parentState, PARENT_STATE_RUNTIME_PATH)) {
		push(item.path, "parent state", item.value);
	}
	for (const artifact of input.artifacts ?? []) {
		push(`artifact:${artifact.id}.summary`, "artifact summary", artifact.summary);
	}

	const deduped = new Map<string, RlmCompiledExactValue>();
	for (const item of candidates) {
		const key = `${item.path}:${item.value}`;
		if (!deduped.has(key)) deduped.set(key, item);
	}
	return Array.from(deduped.values()).slice(0, input.limit ?? 2);
}

export function buildCompiledPromptContext(
	workspaceValue: unknown,
	options: {
		prompt?: string;
		role?: LlmQueryRole;
		parentState?: Record<string, unknown>;
		sectionKeys?: string[];
		evidenceItemLimit?: number;
		evidenceCheckpointLimit?: number;
		artifactLimit?: number;
		exactValueLimit?: number;
	} = {},
): RlmCompiledContext {
	const workspace = isRecord(workspaceValue) ? ensureWorkspaceShape(workspaceValue) : undefined;
	const role = options.role ?? "general";
	const currentAsk = options.prompt?.trim() || undefined;
	const activeContextSummary = buildWorkspaceWorkingSetSummary(workspace);
	const sectionKeys = workspace
		? (options.sectionKeys?.length ? options.sectionKeys : selectRelevantWorkspaceSectionKeys(role, workspace))
		: [];
	const relevantArtifacts = workspace
		? selectRelevantArtifacts(workspace, {
			prompt: currentAsk ?? activeContextSummary ?? "",
			role,
			limit: options.artifactLimit ?? 4,
		})
		: [];
	const workspaceManifest = workspace
		? buildWorkspaceManifest(workspace, {
			sectionKeys,
			relevantArtifacts,
		})
		: undefined;
	const parentStateManifest = buildStateManifest(options.parentState);
	const selectedEvidenceItems = workspace
		? selectRelevantEvidenceItems(workspace, {
			prompt: currentAsk ?? activeContextSummary,
			limit: options.evidenceItemLimit ?? 4,
			statuses: ["pending", "committed"],
		})
		: [];
	const selectedEvidenceCheckpoints = workspace
		? selectRelevantEvidenceCheckpoints(workspace, {
			prompt: currentAsk ?? activeContextSummary,
			limit: options.evidenceCheckpointLimit ?? 3,
			itemIds: selectedEvidenceItems.map((item) => item.id),
		})
		: [];
	const handles: RlmCompiledContextHandle[] = [
		...Object.entries(workspaceManifest?.sections ?? {}).map(([key, value]) => ({
			kind: "workspace-section" as const,
			ref: key,
			summary: describeManifestValue(value),
			path: value.path,
		})),
		...selectedEvidenceItems.map((item) => ({
			kind: "evidence-item" as const,
			ref: item.id,
			summary: item.summary,
			...(item.files?.length ? { files: item.files } : {}),
			...(item.trust ? { trust: item.trust } : {}),
		})),
		...selectedEvidenceCheckpoints.map((checkpoint) => ({
			kind: "evidence-checkpoint" as const,
			ref: checkpoint.id,
			summary: checkpoint.summary,
			...(checkpoint.files?.length ? { files: checkpoint.files } : {}),
			...(checkpoint.trust ? { trust: checkpoint.trust } : {}),
		})),
		...relevantArtifacts.map((artifact) => ({
			kind: "artifact" as const,
			ref: artifact.id,
			summary: artifact.summary ?? `${artifact.role} artifact`,
			...(artifact.files?.length ? { files: artifact.files } : {}),
		})),
	];
	const executionMetadata = [
		`Workspace sections selected: ${Object.keys(workspaceManifest?.sections ?? {}).length}`,
		`Evidence handles selected: ${selectedEvidenceItems.length}`,
		`Checkpoint handles selected: ${selectedEvidenceCheckpoints.length}`,
		`Artifact handles selected: ${relevantArtifacts.length}`,
		`Pending consolidation: ${workspace?.meta?.coordination?.pendingConsolidation === true ? "yes" : "no"}`,
		`Transcript replay is not working memory; use externalized handles and workspace state first.`,
	];
	const exactValues = selectExactContextValues({
		workspace,
		parentState: options.parentState,
		artifacts: relevantArtifacts,
		prompt: currentAsk ?? activeContextSummary,
		limit: options.exactValueLimit ?? 2,
	});
	return {
		version: 1,
		...(currentAsk ? { currentAsk } : {}),
		...(activeContextSummary ? { activeContextSummary } : {}),
		...(workspace ? { pointerHints: buildWorkspacePointerHints(workspace) } : {}),
		...(workspaceManifest ? { workspaceManifest } : {}),
		...(parentStateManifest ? { parentStateManifest } : {}),
		handles,
		exactValues,
		executionMetadata,
	};
}

export function renderCompiledPromptContext(
	compiled: RlmCompiledContext,
	options: {
		title?: string;
		includeCurrentAsk?: boolean;
		includePointers?: boolean;
	} = {},
): string {
	const lines = [options.title ?? "RLM compiled working set from externalized state."];
	if (options.includeCurrentAsk !== false && compiled.currentAsk) lines.push("", "Current ask:", compiled.currentAsk);
	if (compiled.activeContextSummary) lines.push("", "Active context:", compiled.activeContextSummary);
	if (compiled.workspaceManifest) {
		lines.push("", "Workspace manifest handles:");
		for (const handle of compiled.handles.filter((item) => item.kind === "workspace-section")) {
			lines.push(`- ${handle.ref}: ${handle.summary}`);
		}
	}
	if (compiled.parentStateManifest) {
		lines.push("", `Parent state manifest: ${describeManifestValue(compiled.parentStateManifest)}`);
	}
	const evidenceHandles = compiled.handles.filter((item) => item.kind === "evidence-item");
	if (evidenceHandles.length > 0) {
		lines.push("", "Selected evidence handles:");
		for (const handle of evidenceHandles) {
			const files = handle.files?.length ? ` | files: ${handle.files.join(", ")}` : "";
			const trust = handle.trust ? ` | trust: ${handle.trust}` : "";
			lines.push(`- ${handle.ref}: ${handle.summary}${files}${trust}`);
		}
	}
	const checkpointHandles = compiled.handles.filter((item) => item.kind === "evidence-checkpoint");
	if (checkpointHandles.length > 0) {
		lines.push("", "Selected checkpoint handles:");
		for (const handle of checkpointHandles) {
			const files = handle.files?.length ? ` | files: ${handle.files.join(", ")}` : "";
			lines.push(`- ${handle.ref}: ${handle.summary}${files}`);
		}
	}
	const artifactHandles = compiled.handles.filter((item) => item.kind === "artifact");
	if (artifactHandles.length > 0) {
		lines.push("", "Selected artifact handles:");
		for (const handle of artifactHandles) {
			const files = handle.files?.length ? ` | files: ${handle.files.join(", ")}` : "";
			lines.push(`- ${handle.ref}: ${handle.summary}${files}`);
		}
	}
	if (compiled.exactValues.length > 0) {
		lines.push("", "Narrow exact values:");
		for (const item of compiled.exactValues) {
			lines.push(`- ${item.path} (${item.reason}): ${item.value}`);
		}
	}
	if (compiled.executionMetadata.length > 0) {
		lines.push("", "Execution metadata:");
		for (const item of compiled.executionMetadata) lines.push(`- ${item}`);
	}
	if (options.includePointers !== false && compiled.pointerHints) {
		lines.push("", "Pointers:", compiled.pointerHints);
	}
	return lines.join("\n");
}

export function attachInternalLlmQueryContext<T>(
	input: T,
	context: { workspace?: RlmWorkspace | null; queryMode?: RlmQueryMode },
): T {
	if (!isRecord(input)) return input;
	if (context.workspace === undefined && context.queryMode === undefined) return input;
	return {
		...(input as Record<string, unknown>),
		[INTERNAL_LLM_QUERY_CONTEXT_KEY]: context,
	} as T;
}

export function splitInternalLlmQueryContext(input: unknown): {
	publicInput: unknown;
	workspace?: RlmWorkspace | null;
	queryMode?: RlmQueryMode;
} {
	if (!isRecord(input) || !(INTERNAL_LLM_QUERY_CONTEXT_KEY in input)) return { publicInput: input };
	const next = { ...input };
	const internal = next[INTERNAL_LLM_QUERY_CONTEXT_KEY];
	delete next[INTERNAL_LLM_QUERY_CONTEXT_KEY];
	const workspace = isRecord(internal) || internal === null ? ((internal as { workspace?: RlmWorkspace | null })?.workspace ?? undefined) : undefined;
	const queryMode = isRecord(internal) && typeof internal.queryMode === "string" && (internal.queryMode === "simple" || internal.queryMode === "recursive")
		? (internal.queryMode as RlmQueryMode)
		: undefined;
	return { publicInput: next, workspace, queryMode };
}
