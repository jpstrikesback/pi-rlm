import { isDeepStrictEqual } from "node:util";
import { Worker } from "node:worker_threads";
import type {
	ExecResult,
	GlobalsInspection,
	LlmQueryFunction,
	RlmExternalizationKernelMode,
	RlmHistoryTurn,
	RlmRuntimeContext,
	RuntimeSnapshot,
} from "./types.js";

type PendingRequest = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timeout?: ReturnType<typeof setTimeout>;
};

const EXEC_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 5000;
const RESTORE_TIMEOUT_MS = 30000;

function createWorkerSource() {
	function workerMain() {
		const { parentPort } = require("node:worker_threads");
		const vm = require("node:vm");

		const runtimeBindings = Object.create(null);
		const pendingRpc = new Map();
		let rpcCounter = 0;

		const VM_SYNC_TIMEOUT_MS = 1000;
		const MAX_PREVIEW = 160;
		const MAX_STDOUT_CHARS = 8000;
		const MAX_LOG_LINES = 200;
		const MAX_CHILD_ARTIFACTS = 24;
		const SIMPLE_BATCH_CONCURRENCY = 6;
		const RECURSIVE_BATCH_CONCURRENCY = 3;
		const INTERNAL_CHILD_ARTIFACT_KEY = "__rlmInternal";
		const INTERNAL_LLM_QUERY_CONTEXT_KEY = "__rlmRuntimeContext";
		const SUPPORTED_WORKSPACE_COMMIT_KEYS = new Set(["goal", "plan", "files", "findings", "openQuestions", "partialOutputs"]);
		const SYSTEM_RUNTIME_KEYS = new Set([
			"workspace",
			"parentState",
			"input",
			"context",
			"history",
			"llm_query",
			"llm_query_batched",
			"rlm_query",
			"rlm_query_batched",
			"SHOW_VARS",
			"FINAL",
			"FINAL_VAR",
		]);
		const DANGEROUS_GLOBALS = [
			"process",
			"require",
			"module",
			"global",
			"fetch",
			"XMLHttpRequest",
			"WebSocket",
			"EventSource",
			"Worker",
			"SharedWorker",
			"navigator",
			"location",
			"eval",
			"Function",
		];
		const RESERVED_KEYS = new Set([
			...DANGEROUS_GLOBALS,
			"console",
			"globalThis",
			"inspectGlobals",
			"llmQuery",
			"final",
		]);
			const isGeneratedHistoryKey = (key: string) => /^history_\d+$/.test(key);
			const isHelperKey = (key: string) => RESERVED_KEYS.has(key) || SYSTEM_RUNTIME_KEYS.has(key) || isGeneratedHistoryKey(key);
			const isUserBindingKey = (key: string) => !isHelperKey(key);

		const formatError = (error: unknown): string => {
			if (error instanceof Error) return error.stack || error.message || String(error);
			return String(error);
		};

		const typeOfValue = (value: unknown): string => {
			if (value === null) return "null";
			if (Array.isArray(value)) return "array";
			if (value instanceof Map) return "map";
			if (value instanceof Set) return "set";
			if (value instanceof Date) return "date";
			return typeof value === "object" ? value.constructor?.name?.toLowerCase?.() || "object" : typeof value;
		};

		const sizeOfValue = (value: unknown): string | undefined => {
			if (Array.isArray(value)) return `${value.length} items`;
			if (value instanceof Map || value instanceof Set) return `${value.size} items`;
			if (value && typeof value === "object") return `${Object.keys(value).length} keys`;
			if (typeof value === "string") return `${value.length} chars`;
			return undefined;
		};

		const serializePreview = (value: unknown): string => {
			try {
				if (typeof value === "string")
					return value.length > MAX_PREVIEW ? `${value.slice(0, MAX_PREVIEW - 1)}…` : value;
				const seen = new WeakSet();
				const text = JSON.stringify(value, (_key: string, inner: unknown) => {
					if (typeof inner === "function") return "[Function]";
					if (typeof inner === "object" && inner !== null) {
						if (seen.has(inner)) return "[Circular]";
						seen.add(inner);
					}
					if (inner instanceof Map) return { __type: "Map", entries: Array.from(inner.entries()).slice(0, 5) };
					if (inner instanceof Set) return { __type: "Set", values: Array.from(inner.values()).slice(0, 5) };
					if (inner instanceof Date) return inner.toISOString();
					return inner;
				});
				if (!text) return String(value);
				return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 1)}…` : text;
			} catch {
				try {
					const text = String(value);
					return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 1)}…` : text;
				} catch {
					return "[Unserializable]";
				}
			}
		};

		const canClone = (value: unknown): boolean => {
			try {
				structuredClone(value);
				return true;
			} catch {
				return false;
			}
		};

		const sanitizeWorkspaceForPersistence = (value: unknown) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return value;
			const plain = Object.assign(Object.create(null), value as Record<string, unknown>);
			return canClone(plain) ? structuredClone(plain) : undefined;
		};

			const buildInspectionFromSource = (source: Record<string, unknown>, keyFilter: (key: string) => boolean = () => true) => {
			const entries = Object.keys(source)
				.filter((name) => keyFilter(name))
				.sort((a, b) => a.localeCompare(b))
				.map((name) => {
					const value = source[name];
					return {
						name,
						type: typeOfValue(value),
						size: sizeOfValue(value),
						preview: serializePreview(value),
						restorable: canClone(value),
					};
				});
			const table = entries.length
				? entries
						.map(
							(entry) =>
								`- ${entry.name}: ${entry.type}${entry.size ? ` (${entry.size})` : ""}${entry.preview ? ` = ${entry.preview}` : ""}${entry.restorable ? "" : " [preview-only]"}`,
						)
						.join("\n")
				: "(runtime empty)";
			return { entries, table };
		};

		const inspect = () => {
			return buildInspectionFromSource(runtimeBindings);
		};

		const snapshot = () => {
			const inspection = inspect();
			const bindings = Object.create(null);
			for (const key of Object.keys(runtimeBindings)) {
				const value = key === "workspace" ? sanitizeWorkspaceForPersistence(runtimeBindings[key]) : runtimeBindings[key];
				if (!canClone(value)) continue;
				bindings[key] = structuredClone(value);
			}
			return { version: 1, bindings, entries: inspection.entries };
		};

		const restore = (input: { bindings?: Record<string, unknown> }) => {
			for (const key of Object.keys(runtimeBindings)) delete runtimeBindings[key];
			for (const [key, value] of Object.entries(input?.bindings || {})) {
				runtimeBindings[key] = value;
			}
			const workspace = runtimeBindings.workspace;
			if (workspace && typeof workspace === "object" && !Array.isArray(workspace)) {
				refreshWorkspaceProjection(workspace as Record<string, unknown>);
			}
			return { inspection: inspect(), snapshot: snapshot() };
		};

		const reset = () => restore({ bindings: {} });

		const callParent = (method: string, payload: unknown) =>
			new Promise((resolve, reject) => {
				const rpcId = `rpc-${++rpcCounter}`;
				pendingRpc.set(rpcId, { resolve, reject });
				parentPort.postMessage({ type: "rpc", rpcId, method, payload });
			});

		const createConsoleProxy = (logs: string[]) => {
			const push = (...args: unknown[]) => {
				if (logs.length >= MAX_LOG_LINES) return;
				const line = args.map((arg) => serializePreview(arg)).join(" ");
				logs.push(line);
			};
			return { log: push, info: push, warn: push, error: push };
		};

		const ensureWorkspace = (sandbox: Record<string, unknown>) => {
			const current = sandbox.workspace;
			const workspace = prepareWorkspaceObject(current && typeof current === "object" && !Array.isArray(current) ? current : Object.create(null));
			sandbox.workspace = workspace;
			return workspace;
		};

		const normalizeStringList = (value: unknown) =>
			Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : undefined;

		function normalizeCoordination(value: unknown) {
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
			const next = Object.create(null) as Record<string, unknown>;
			if (typeof (value as Record<string, unknown>).hasCommitted === "boolean") next.hasCommitted = (value as Record<string, unknown>).hasCommitted;
			if (typeof (value as Record<string, unknown>).pendingConsolidation === "boolean") next.pendingConsolidation = (value as Record<string, unknown>).pendingConsolidation;
			if (typeof (value as Record<string, unknown>).lastCommittedTurn === "number") next.lastCommittedTurn = (value as Record<string, unknown>).lastCommittedTurn;
			if (typeof (value as Record<string, unknown>).lastLeafToolTurn === "number") next.lastLeafToolTurn = (value as Record<string, unknown>).lastLeafToolTurn;
			const changedKeys = normalizeStringList((value as Record<string, unknown>).lastCommitChangedKeys);
			if (changedKeys) next.lastCommitChangedKeys = changedKeys;
			const pendingBurstIds = normalizeStringList((value as Record<string, unknown>).pendingBurstIds);
			if (pendingBurstIds) next.pendingBurstIds = pendingBurstIds;
			const meaningfulPendingBurstIds = normalizeStringList((value as Record<string, unknown>).meaningfulPendingBurstIds);
			if (meaningfulPendingBurstIds) next.meaningfulPendingBurstIds = meaningfulPendingBurstIds;
			const lastCommitConsolidatedIds = normalizeStringList((value as Record<string, unknown>).lastCommitConsolidatedIds);
			if (lastCommitConsolidatedIds) next.lastCommitConsolidatedIds = lastCommitConsolidatedIds;
			const lastCommitConsolidatedBurstIds = normalizeStringList((value as Record<string, unknown>).lastCommitConsolidatedBurstIds);
			if (lastCommitConsolidatedBurstIds) next.lastCommitConsolidatedBurstIds = lastCommitConsolidatedBurstIds;
			if (typeof (value as Record<string, unknown>).lastCommitSatisfiedProtocol === "boolean") next.lastCommitSatisfiedProtocol = (value as Record<string, unknown>).lastCommitSatisfiedProtocol;
			return Object.keys(next).length > 0 ? next : undefined;
		}

		function ensureCoordinationMeta(meta: Record<string, unknown>) {
			const coordination = normalizeCoordination(meta.coordination) ?? Object.create(null);
			meta.coordination = coordination;
			return coordination;
		}

		function isLeafBurstProtocolEnabled(workspace: Record<string, unknown>) {
			const meta = workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta)
				? (workspace.meta as Record<string, unknown>)
				: undefined;
			return meta?.leafBurstProtocolEnabled !== false;
		}

		function clearLeafBurstProtocolState(coordination: Record<string, unknown>) {
			delete coordination.pendingBurstIds;
			delete coordination.meaningfulPendingBurstIds;
			delete coordination.lastCommitConsolidatedIds;
			delete coordination.lastCommitConsolidatedBurstIds;
			delete coordination.lastCommitSatisfiedProtocol;
		}

		function prepareWorkspaceObject(workspace: Record<string, unknown>) {
			if (!Array.isArray(workspace.childArtifacts)) workspace.childArtifacts = [];
			if (!Array.isArray(workspace.childArtifactSummaries)) workspace.childArtifactSummaries = [];
			const artifactIndex =
				workspace.artifactIndex && typeof workspace.artifactIndex === "object" && !Array.isArray(workspace.artifactIndex)
					? (workspace.artifactIndex as Record<string, unknown>)
					: (workspace.artifactIndex = Object.create(null));
			if (!artifactIndex.byId || typeof artifactIndex.byId !== "object" || Array.isArray(artifactIndex.byId)) {
				artifactIndex.byId = Object.create(null);
			}
			if (!artifactIndex.byTag || typeof artifactIndex.byTag !== "object" || Array.isArray(artifactIndex.byTag)) {
				artifactIndex.byTag = Object.create(null);
			}
			if (!artifactIndex.byFile || typeof artifactIndex.byFile !== "object" || Array.isArray(artifactIndex.byFile)) {
				artifactIndex.byFile = Object.create(null);
			}
			if (!Array.isArray(artifactIndex.recentIds)) artifactIndex.recentIds = [];
			const evidence =
				workspace.evidence && typeof workspace.evidence === "object" && !Array.isArray(workspace.evidence)
					? (workspace.evidence as Record<string, unknown>)
					: (workspace.evidence = Object.create(null));
			if (!Array.isArray(evidence.items)) evidence.items = [];
			if (!Array.isArray(evidence.checkpoints)) evidence.checkpoints = [];
			if (!Array.isArray(evidence.pendingIds)) {
				evidence.pendingIds = (evidence.items as Array<Record<string, unknown>>)
					.filter((item) => item && typeof item === "object" && !Array.isArray(item) && ((item.status === "pending") || (item.committed !== true && item.kind === "tool")))
					.map((item) => item.id)
					.filter((item): item is string => typeof item === "string");
			}
			const meta =
				workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta)
					? (workspace.meta as Record<string, unknown>)
					: (workspace.meta = { version: 1 });
			meta.version = 1;
			const coordination = normalizeCoordination(meta.coordination);
			if (coordination) meta.coordination = coordination;
			else delete meta.coordination;
			refreshWorkspaceProjection(workspace);
			return workspace;
		}

		const extractReferenceList = (value: unknown) => {
			if (!Array.isArray(value)) return [] as string[];
			const refs: string[] = [];
			for (const item of value) {
				if (!item || typeof item !== "object" || Array.isArray(item)) continue;
				const record = item as Record<string, unknown>;
				for (const candidate of [record.ref, record.path, record.id]) {
					if (typeof candidate === "string" && candidate.trim().length > 0) refs.push(candidate);
				}
			}
			return Array.from(new Set(refs));
		};

		const buildWorkspaceActiveContext = (workspace: Record<string, unknown>) => {
			const goal = typeof workspace.goal === "string" && workspace.goal.trim().length > 0 ? workspace.goal.trim() : undefined;
			const currentPlan = normalizeStringList(workspace.plan)?.slice(0, 8);
			const relevantFiles = normalizeStringList(workspace.files)?.slice(0, 8);
			const currentQuestions = normalizeStringList(workspace.openQuestions)?.slice(0, 6);
			const artifactIndex =
				workspace.artifactIndex && typeof workspace.artifactIndex === "object" && !Array.isArray(workspace.artifactIndex)
					? (workspace.artifactIndex as Record<string, unknown>)
					: undefined;
			const recentArtifactIds = Array.isArray(artifactIndex?.recentIds)
				? artifactIndex.recentIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				: [];
			const currentArtifactRefs = Array.from(
				new Set([
					...(Array.isArray(workspace.childArtifacts)
						? workspace.childArtifacts.flatMap((artifact) => {
							if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return [] as string[];
							const record = artifact as Record<string, unknown>;
							return [record.id, record.childId].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
						})
						: []),
					...recentArtifactIds,
				]),
			).slice(-6);
			const currentFindingsRefs = Array.from(
				new Set([
					...extractReferenceList(workspace.findings),
					...(workspace.partialOutputs && typeof workspace.partialOutputs === "object" && !Array.isArray(workspace.partialOutputs)
						? Object.keys(workspace.partialOutputs).filter((key) => key.trim().length > 0)
						: []),
				]),
			);
			const summaryParts: string[] = [];
			if (goal) summaryParts.push(`Goal: ${goal}`);
			if (currentPlan?.length) summaryParts.push(`Plan: ${currentPlan.slice(0, 3).join(" · ")}`);
			if (relevantFiles?.length) summaryParts.push(`Files: ${relevantFiles.slice(0, 4).join(", ")}`);
			if (currentQuestions?.length) summaryParts.push(`Questions: ${currentQuestions.slice(0, 3).join(" · ")}`);
			if (currentArtifactRefs.length) summaryParts.push(`Artifacts: ${currentArtifactRefs.slice(-4).join(", ")}`);
			const summary = summaryParts.length > 0 ? summaryParts.join("\n") : undefined;
			const meta = workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta) ? (workspace.meta as Record<string, unknown>) : undefined;
			const lastChildArtifact = workspace.lastChildArtifact && typeof workspace.lastChildArtifact === "object" && !Array.isArray(workspace.lastChildArtifact)
				? (workspace.lastChildArtifact as Record<string, unknown>)
				: undefined;
			const updatedAt = typeof meta?.updatedAt === "string" ? meta.updatedAt : typeof lastChildArtifact?.producedAt === "string" ? lastChildArtifact.producedAt : undefined;
			return {
				...(goal ? { goal } : {}),
				...(currentPlan ? { currentPlan } : {}),
				...(relevantFiles ? { relevantFiles } : {}),
				...(currentQuestions ? { currentQuestions } : {}),
				...(currentFindingsRefs.length > 0 ? { currentFindingsRefs } : {}),
				...(currentArtifactRefs.length > 0 ? { currentArtifactRefs } : {}),
				...(summary ? { summary } : {}),
				...(updatedAt ? { updatedAt } : {}),
			};
		};

		const refreshWorkspaceProjection = (workspace: Record<string, unknown>) => {
			const activeContext = buildWorkspaceActiveContext(workspace);
			workspace.activeContext = activeContext;
			const meta = {
				version: 1,
				...(workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta) ? workspace.meta : {}),
			} as Record<string, unknown>;
			if (activeContext.currentPlan) meta.activePlanRef = "globalThis.workspace.activeContext.currentPlan";
			else delete meta.activePlanRef;
			if (Array.isArray(activeContext.currentArtifactRefs) && activeContext.currentArtifactRefs.length > 0) meta.activeArtifactRefs = [...activeContext.currentArtifactRefs];
			else delete meta.activeArtifactRefs;
			workspace.meta = meta;
			return workspace;
		};

		const appendUniqueStrings = (existingValue: unknown, incomingValue: unknown) => {
			const existing = normalizeStringList(existingValue) ?? [];
			const incoming = normalizeStringList(incomingValue) ?? [];
			if (incoming.length === 0) return { next: existing, changed: false };
			const seen = new Set(existing);
			const next = [...existing];
			let changed = false;
			for (const item of incoming) {
				if (seen.has(item)) continue;
				seen.add(item);
				next.push(item);
				changed = true;
			}
			return { next, changed };
		};

		const normalizeCommitFindings = (value: unknown) => {
			if (!Array.isArray(value)) return [] as Array<string | Record<string, unknown>>;
			const next: Array<string | Record<string, unknown>> = [];
			for (const item of value) {
				if (typeof item === "string" && item.trim().length > 0) {
					next.push(item);
					continue;
				}
				if (!item || typeof item !== "object" || Array.isArray(item) || !canClone(item)) continue;
				next.push(structuredClone(item as Record<string, unknown>));
			}
			return next;
		};

		const normalizeCommitPartialOutputs = (value: unknown) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return Object.create(null);
			const next = Object.create(null) as Record<string, unknown>;
			for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
				if (!key.trim() || !canClone(inner)) continue;
				next[key] = structuredClone(inner);
			}
			return next;
		};

		const appendUniqueCompactStrings = (existingValue: unknown, incomingValue: unknown, limit = 6) => {
			const existing = normalizeStringList(existingValue) ?? [];
			const incoming = normalizeStringList(incomingValue) ?? [];
			const next = Array.from(new Set([...existing, ...incoming]));
			return next.length > 0 ? next.slice(0, limit) : undefined;
		};

		const buildPendingEvidenceBursts = (workspace: Record<string, unknown>) => {
			const evidence = workspace.evidence && typeof workspace.evidence === "object" && !Array.isArray(workspace.evidence)
				? (workspace.evidence as Record<string, unknown>)
				: undefined;
			const items = Array.isArray(evidence?.items) ? evidence.items : [];
			const groups = new Map<string, Array<Record<string, unknown>>>();
			for (const value of items) {
				if (!value || typeof value !== "object" || Array.isArray(value)) continue;
				const item = value as Record<string, unknown>;
				if (item.kind !== "tool") continue;
				const status = item.status === "committed" ? "committed" : "pending";
				if (status !== "pending") continue;
				const key = typeof item.burstId === "string" ? item.burstId : typeof item.id === "string" ? item.id : undefined;
				if (!key) continue;
				const existing = groups.get(key);
				if (existing) existing.push(item);
				else groups.set(key, [item]);
			}
			return Array.from(groups.entries()).map(([id, burstItems]) => {
				const first = burstItems[0];
				const toolNames = appendUniqueCompactStrings(undefined, burstItems.flatMap((item) => normalizeStringList(item.toolNames) ?? (typeof item.toolName === "string" ? [item.toolName] : [])), 6);
				const files = appendUniqueCompactStrings(undefined, burstItems.flatMap((item) => normalizeStringList(item.files) ?? []), 6);
				const salience = Math.max(...burstItems.map((item) => typeof item.salience === "number" ? item.salience : 1));
				const requiresCommit = burstItems.some((item) => {
					const fileCount = normalizeStringList(item.files)?.length ?? 0;
					const toolCount = normalizeStringList(item.toolNames)?.length ?? (typeof item.toolName === "string" ? 1 : 0);
					if (fileCount > 0) return true;
					if (toolCount > 1) return true;
					if ((typeof item.salience === "number" ? item.salience : 0) >= 2) return true;
					return typeof item.summary === "string" && /error/i.test(item.summary);
				});
				return {
					id,
					turnIndex: typeof first.turnIndex === "number" ? first.turnIndex : 0,
					itemIds: burstItems.map((item) => item.id).filter((value): value is string => typeof value === "string"),
					toolNames,
					files,
					salience,
					requiresCommit,
				};
			}).sort((left, right) => (right.turnIndex - left.turnIndex) || (right.salience - left.salience) || String(left.id).localeCompare(String(right.id)));
		};

		const refreshEvidenceCoordination = (workspace: Record<string, unknown>) => {
			const meta = workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta)
				? (workspace.meta as Record<string, unknown>)
				: (workspace.meta = { version: 1 });
			const existing = normalizeCoordination(meta.coordination) ?? Object.create(null);
			if (!isLeafBurstProtocolEnabled(workspace)) {
				clearLeafBurstProtocolState(existing);
				if (Object.keys(existing).length > 0) meta.coordination = existing;
				else delete meta.coordination;
				return { pendingBursts: [] as ReturnType<typeof buildPendingEvidenceBursts>, meaningfulPendingBursts: [] as ReturnType<typeof buildPendingEvidenceBursts> };
			}
			const pendingBursts = buildPendingEvidenceBursts(workspace);
			const meaningfulPendingBursts = pendingBursts.filter((burst) => burst.requiresCommit);
			const evidence = workspace.evidence && typeof workspace.evidence === "object" && !Array.isArray(workspace.evidence)
				? (workspace.evidence as Record<string, unknown>)
				: undefined;
			const hasEvidenceState = (Array.isArray(evidence?.items) && evidence.items.length > 0)
				|| ((normalizeStringList(evidence?.pendingIds) ?? []).length > 0)
				|| ((normalizeStringList(existing.pendingBurstIds) ?? []).length > 0)
				|| ((normalizeStringList(existing.meaningfulPendingBurstIds) ?? []).length > 0)
				|| typeof existing.pendingConsolidation === "boolean";
			if (hasEvidenceState) {
				existing.pendingConsolidation = meaningfulPendingBursts.length > 0;
				if (pendingBursts.length > 0) existing.pendingBurstIds = pendingBursts.map((burst) => burst.id);
				else delete existing.pendingBurstIds;
				if (meaningfulPendingBursts.length > 0) existing.meaningfulPendingBurstIds = meaningfulPendingBursts.map((burst) => burst.id);
				else delete existing.meaningfulPendingBurstIds;
			}
			if (Object.keys(existing).length > 0) meta.coordination = existing;
			else delete meta.coordination;
			return { pendingBursts, meaningfulPendingBursts };
		};

		const applyCommitEvidenceProtocol = (workspace: Record<string, unknown>, turnIndex: number, changedKeys: string[], now: string) => {
			prepareWorkspaceObject(workspace);
			const meta = workspace.meta as Record<string, unknown>;
			if (!isLeafBurstProtocolEnabled(workspace)) {
				const coordination = ensureCoordinationMeta(meta);
				clearLeafBurstProtocolState(coordination);
				if (changedKeys.length > 0) coordination.pendingConsolidation = false;
				if (Object.keys(coordination).length === 0) delete meta.coordination;
				return {
					pendingConsolidation: coordination.pendingConsolidation === true,
				};
			}
			const evidence = workspace.evidence as Record<string, unknown>;
			const pendingBefore = refreshEvidenceCoordination(workspace).meaningfulPendingBursts;
			const pendingIds = normalizeStringList(evidence.pendingIds) ?? [];
			const items = Array.isArray(evidence.items) ? evidence.items as Array<Record<string, unknown>> : [];
			const pendingItems = items.filter((item) => pendingIds.includes(String(item.id)));
			const canConsolidate = changedKeys.length > 0 && pendingItems.length > 0;
			const consolidatedEvidenceIds = canConsolidate ? pendingItems.map((item) => String(item.id)) : [];
			const consolidatedBurstIds = canConsolidate
				? pendingBefore.filter((burst) => burst.itemIds.some((id) => consolidatedEvidenceIds.includes(id))).map((burst) => burst.id)
				: [];
			if (canConsolidate) {
				for (const item of pendingItems) {
					item.status = "committed";
					item.committed = true;
					item.updatedAt = now;
				}
				evidence.pendingIds = [];
			}
			const files = normalizeStringList(workspace.files)?.slice(0, 6);
			const commitItem = {
				id: `commit:${turnIndex}:${now}:${changedKeys.join("+") || "noop"}`,
				turnIndex,
				kind: "commit",
				summary: files?.length
					? `workspace.commit: ${changedKeys.length > 0 ? changedKeys.join(", ") : "no-op"} | files: ${files.join(", ")}${consolidatedEvidenceIds.length ? ` | consolidated observations: ${consolidatedEvidenceIds.length}` : ""}`
					: `workspace.commit: ${changedKeys.length > 0 ? changedKeys.join(", ") : "no-op"}${consolidatedEvidenceIds.length ? ` | consolidated observations: ${consolidatedEvidenceIds.length}` : ""}`,
				...(files ? { files } : {}),
				...(files ? { refs: files } : {}),
				...(changedKeys.length ? { changedKeys } : {}),
				...(consolidatedEvidenceIds.length ? { consolidatedIds: consolidatedEvidenceIds } : {}),
				trust: "grounded",
				salience: Math.max(1, Math.min(10, (files?.length ?? 0) + changedKeys.length + 2)),
				status: "committed",
				committed: true,
				createdAt: now,
				updatedAt: now,
			};
			const remainingItems = items.filter((item) => item.id !== commitItem.id);
			evidence.items = [...remainingItems, commitItem].slice(-32);
			if (!Array.isArray(evidence.checkpoints)) evidence.checkpoints = [];
			if (consolidatedEvidenceIds.length > 0) {
				(evidence.checkpoints as Array<Record<string, unknown>>).push({
					id: `checkpoint:${turnIndex}:${now}`,
					turnIndex,
					summary: files?.length
						? `checkpoint: changed ${changedKeys.length > 0 ? changedKeys.join(", ") : "committed observations"} | files: ${files.join(", ")} | items: ${consolidatedEvidenceIds.length}`
						: `checkpoint: changed ${changedKeys.length > 0 ? changedKeys.join(", ") : "committed observations"} | items: ${consolidatedEvidenceIds.length}`,
					itemIds: consolidatedEvidenceIds,
					...(files ? { files } : {}),
					...(files ? { refs: files } : {}),
					trust: "grounded",
					salience: Math.max(1, Math.min(10, (files?.length ?? 0) + changedKeys.length + 3)),
					createdAt: now,
					updatedAt: now,
				});
				if ((evidence.checkpoints as Array<Record<string, unknown>>).length > 16) {
					evidence.checkpoints = (evidence.checkpoints as Array<Record<string, unknown>>).slice(-16);
				}
			}
			const meaningfulPendingAfter = refreshEvidenceCoordination(workspace).meaningfulPendingBursts;
			const satisfiedProtocol = pendingBefore.length === 0 || (canConsolidate && meaningfulPendingAfter.length === 0);
			const coordination = ensureCoordinationMeta(meta);
			coordination.lastCommitConsolidatedIds = consolidatedEvidenceIds;
			coordination.lastCommitConsolidatedBurstIds = consolidatedBurstIds;
			coordination.lastCommitSatisfiedProtocol = satisfiedProtocol;
			return {
				pendingConsolidation: coordination.pendingConsolidation === true,
				meaningfulPendingBeforeCommit: pendingBefore.length,
				meaningfulPendingAfterCommit: meaningfulPendingAfter.length,
				satisfiedProtocol,
				...(consolidatedEvidenceIds.length ? { consolidatedEvidenceIds } : {}),
				...(consolidatedBurstIds.length ? { consolidatedBurstIds } : {}),
			};
		};

		const buildWorkspaceState = (workspace: Record<string, unknown> | undefined) => {
			if (!workspace) return undefined;
			const meta = workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta)
				? (workspace.meta as Record<string, unknown>)
				: undefined;
			const coordination = meta?.coordination && typeof meta.coordination === "object" && !Array.isArray(meta.coordination)
				? (meta.coordination as Record<string, unknown>)
				: undefined;
			const activeContext = workspace.activeContext && typeof workspace.activeContext === "object" && !Array.isArray(workspace.activeContext)
				? (workspace.activeContext as Record<string, unknown>)
				: undefined;
			const protocolEnabled = isLeafBurstProtocolEnabled(workspace);
			const pendingBursts = protocolEnabled ? buildPendingEvidenceBursts(workspace) : [];
			const meaningfulPendingBursts = protocolEnabled ? pendingBursts.filter((burst) => burst.requiresCommit) : [];
			return {
				hasCommitted: coordination?.hasCommitted === true,
				pendingConsolidation: coordination?.pendingConsolidation === true,
				...(typeof coordination?.lastCommittedTurn === "number" ? { lastCommittedTurn: coordination.lastCommittedTurn } : {}),
				...(typeof coordination?.lastLeafToolTurn === "number" ? { lastLeafToolTurn: coordination.lastLeafToolTurn } : {}),
				...(Array.isArray(coordination?.lastCommitChangedKeys) ? { lastCommitChangedKeys: coordination.lastCommitChangedKeys } : {}),
				...(protocolEnabled ? { pendingBurstCount: pendingBursts.length, meaningfulPendingBurstCount: meaningfulPendingBursts.length } : {}),
				...(protocolEnabled && typeof coordination?.lastCommitSatisfiedProtocol === "boolean" ? { lastCommitSatisfiedProtocol: coordination.lastCommitSatisfiedProtocol } : {}),
				planLength: Array.isArray(workspace.plan) ? workspace.plan.length : 0,
				findingCount: Array.isArray(workspace.findings) ? workspace.findings.length : 0,
				artifactCount: Array.isArray(workspace.childArtifacts) ? workspace.childArtifacts.length : 0,
				...(typeof activeContext?.summary === "string" ? { activeContextSummary: activeContext.summary } : {}),
			};
		};

		const rebuildArtifactIndex = (artifacts: Array<Record<string, unknown>>) => {
			const byId = Object.create(null);
			const byTag = Object.create(null);
			const byFile = Object.create(null);
			const recentIds: string[] = [];
			for (const artifact of artifacts) {
				const id = typeof artifact.id === "string" ? artifact.id : typeof artifact.childId === "string" ? artifact.childId : undefined;
				if (!id) continue;
				byId[id] = artifact;
				recentIds.push(id);
				for (const tag of normalizeStringList(artifact.tags) || []) {
					(byTag[tag] ||= []).push(id);
				}
				for (const file of normalizeStringList(artifact.files) || []) {
					(byFile[file] ||= []).push(id);
				}
			}
			return { byId, byTag, byFile, recentIds };
		};

		const normalizeRuntimeQueryInput = (input: unknown, options: Record<string, unknown> | undefined, queryMode: "simple" | "recursive") => {
			if (typeof input === "string" && input.trim().length > 0) {
				const next = Object.create(null);
				next.prompt = input;
				if (options && typeof options === "object" && !Array.isArray(options)) {
					for (const [key, value] of Object.entries(options)) {
						if (value !== undefined) next[key] = value;
					}
				}
				return next;
			}
			if (input && typeof input === "object" && !Array.isArray(input)) {
				const next = Object.assign(Object.create(null), input as Record<string, unknown>);
				if (options && typeof options === "object" && !Array.isArray(options)) {
					for (const [key, value] of Object.entries(options)) {
						if (value !== undefined && !(key in next)) next[key] = value;
					}
				}
				return next;
			}
			throw new Error(`${queryMode} query requires a prompt string or request object`);
		};

		const normalizeRuntimeBatchInputs = (items: unknown, shared: Record<string, unknown> | undefined, queryMode: "simple" | "recursive") => {
			if (!Array.isArray(items) || items.length === 0) throw new Error(`${queryMode} batched query requires a non-empty array`);
			return items.map((item) => normalizeRuntimeQueryInput(item, shared, queryMode));
		};

		const attachRuntimeContextToInput = (
			input: unknown,
			sandbox: Record<string, unknown>,
			queryMode: "simple" | "recursive" = "recursive",
		) => {
			if (!input || typeof input !== "object" || Array.isArray(input)) return input;
			const next = Object.assign(Object.create(null), input as Record<string, unknown>);
			const workspace = sandbox.workspace;
			if ((workspace && typeof workspace === "object" && !Array.isArray(workspace) && canClone(workspace)) || queryMode !== "recursive") {
				next[INTERNAL_LLM_QUERY_CONTEXT_KEY] = {
					...(workspace && typeof workspace === "object" && !Array.isArray(workspace) && canClone(workspace)
						? { workspace: structuredClone(workspace) }
						: {}),
					queryMode,
				};
			}
			return next;
		};

		const stripInternalLlmQueryResult = (value: unknown) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				return { publicValue: value, childArtifact: undefined };
			}
			const source = value as Record<string, unknown>;
			const internal = source[INTERNAL_CHILD_ARTIFACT_KEY] as { childArtifact?: unknown } | undefined;
			const publicValue = Object.assign(Object.create(null), source);
			delete publicValue[INTERNAL_CHILD_ARTIFACT_KEY];
			return {
				publicValue,
				childArtifact: internal?.childArtifact,
			};
		};

		const mergeChildArtifactIntoWorkspace = (sandbox: Record<string, unknown>, artifact: unknown) => {
			if (!artifact || typeof artifact !== "object" || !canClone(artifact)) return;
			const workspace = ensureWorkspace(sandbox) as Record<string, unknown>;
			const clonedArtifact = structuredClone(artifact) as Record<string, unknown>;
			if (typeof clonedArtifact.id !== "string" && typeof clonedArtifact.childId === "string") clonedArtifact.id = clonedArtifact.childId;
			const dataFiles = clonedArtifact.data && typeof clonedArtifact.data === "object" && !Array.isArray(clonedArtifact.data)
				? normalizeStringList((clonedArtifact.data as Record<string, unknown>).files)
				: undefined;
			const dataTags = clonedArtifact.data && typeof clonedArtifact.data === "object" && !Array.isArray(clonedArtifact.data)
				? normalizeStringList((clonedArtifact.data as Record<string, unknown>).tags)
				: undefined;
			clonedArtifact.files = normalizeStringList(clonedArtifact.files) || dataFiles;
			clonedArtifact.tags = normalizeStringList(clonedArtifact.tags) || dataTags;
			const existing = Array.isArray(workspace.childArtifacts) ? workspace.childArtifacts.slice(-(MAX_CHILD_ARTIFACTS - 1)) : [];
			const nextArtifacts = [...existing, clonedArtifact];
			workspace.childArtifacts = nextArtifacts;
			workspace.lastChildArtifact = clonedArtifact;
			workspace.childArtifactSummaries = nextArtifacts.map((entry) => ({
				id: entry.id,
				childId: entry.childId,
				role: entry.role,
				status: entry.status,
				...(typeof entry.summary === "string" && entry.summary.trim() ? { summary: entry.summary } : {}),
				...(normalizeStringList(entry.files)?.length ? { files: normalizeStringList(entry.files) } : {}),
				...(normalizeStringList(entry.tags)?.length ? { tags: normalizeStringList(entry.tags) } : {}),
				...(typeof entry.producedAt === "string" ? { producedAt: entry.producedAt } : {}),
			}));
			workspace.artifactIndex = rebuildArtifactIndex(nextArtifacts);
			workspace.meta = {
				...(workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta) ? workspace.meta : {}),
				version: 1,
				...(typeof clonedArtifact.producedAt === "string" ? { updatedAt: clonedArtifact.producedAt } : {}),
			};
			refreshWorkspaceProjection(workspace);
		};

		const createSandbox = (
			consoleProxy: ReturnType<typeof createConsoleProxy>,
			finalState: { value: unknown },
			executionState: {
				turnIndex?: number;
				leafBurstProtocolEnabled?: boolean;
				allowRuntimeSubcalls?: boolean;
				commitResults: Array<Record<string, unknown>>;
				runtimeContext?: Record<string, unknown>;
				history?: Array<Record<string, unknown>>;
				attemptedSimpleQueryCount: number;
				attemptedSimpleBatchCount: number;
				attemptedRecursiveQueryCount: number;
				attemptedRecursiveBatchCount: number;
				simpleQueryCount: number;
				simpleBatchCount: number;
				recursiveQueryCount: number;
				recursiveBatchCount: number;
				submodelOverrideCount: number;
				showVarsCount: number;
				finalAliasUsed: boolean;
				finalVarAliasUsed: boolean;
			},
		) => {
			const sandbox = Object.create(null);
			let liveWorkspace =
				runtimeBindings.workspace && typeof runtimeBindings.workspace === "object" && !Array.isArray(runtimeBindings.workspace)
					? prepareWorkspaceObject(runtimeBindings.workspace as Record<string, unknown>)
					: undefined;
			let workspaceInitialized = liveWorkspace !== undefined;

			const commitWorkspacePatch = (patchValue: unknown) => {
				const workspace = getWorkspace();
				const patch = patchValue && typeof patchValue === "object" && !Array.isArray(patchValue)
					? (patchValue as Record<string, unknown>)
					: Object.create(null);
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
						if (Array.isArray(patch.plan)) {
							const nextPlan = patch.plan.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0);
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
					workspace.files = next;
					if (changed) changedKeys.push("files");
					else if (!Array.isArray(patch.files)) ignoredKeys.push("files");
				}

				if ("findings" in patch) {
					const findings = normalizeCommitFindings(patch.findings);
					if (findings.length > 0) {
						workspace.findings = [...(Array.isArray(workspace.findings) ? workspace.findings : []), ...findings];
						changedKeys.push("findings");
					} else {
						ignoredKeys.push("findings");
					}
				}

				if ("openQuestions" in patch) {
					const { next, changed } = appendUniqueStrings(workspace.openQuestions, patch.openQuestions);
					workspace.openQuestions = next;
					if (changed) changedKeys.push("openQuestions");
					else if (!Array.isArray(patch.openQuestions)) ignoredKeys.push("openQuestions");
				}

				if ("partialOutputs" in patch) {
					const outputs = normalizeCommitPartialOutputs(patch.partialOutputs);
					if (Object.keys(outputs).length > 0) {
						workspace.partialOutputs = {
							...(workspace.partialOutputs && typeof workspace.partialOutputs === "object" && !Array.isArray(workspace.partialOutputs)
								? (workspace.partialOutputs as Record<string, unknown>)
								: {}),
							...outputs,
						};
						changedKeys.push("partialOutputs");
					} else {
						ignoredKeys.push("partialOutputs");
					}
				}

				const now = new Date().toISOString();
				workspace.meta = {
					version: 1,
					...(workspace.meta && typeof workspace.meta === "object" && !Array.isArray(workspace.meta) ? workspace.meta : {}),
					updatedAt: now,
					...(typeof executionState.leafBurstProtocolEnabled === "boolean" ? { leafBurstProtocolEnabled: executionState.leafBurstProtocolEnabled } : {}),
				};
				const coordination = ensureCoordinationMeta(workspace.meta as Record<string, unknown>);
				coordination.hasCommitted = true;
				if (typeof executionState.turnIndex === "number") coordination.lastCommittedTurn = executionState.turnIndex;
				coordination.lastCommitChangedKeys = [...changedKeys];
				refreshWorkspaceProjection(workspace);
				const protocol = applyCommitEvidenceProtocol(workspace, typeof executionState.turnIndex === "number" ? executionState.turnIndex : 0, changedKeys, now);
				const activeContext = workspace.activeContext && typeof workspace.activeContext === "object" && !Array.isArray(workspace.activeContext)
					? (workspace.activeContext as Record<string, unknown>)
					: undefined;
				const result = {
					ok: true,
					changedKeys,
					ignoredKeys: Array.from(new Set(ignoredKeys)),
					activeContextSummary: typeof activeContext?.summary === "string" ? activeContext.summary : undefined,
					planLength: Array.isArray(workspace.plan) ? workspace.plan.length : 0,
					findingCount: Array.isArray(workspace.findings) ? workspace.findings.length : 0,
					...protocol,
				};
				executionState.commitResults.push(result);
				return result;
			};

			const attachWorkspaceCommitHelper = (workspace: Record<string, unknown>) => {
				Object.defineProperty(workspace, "commit", {
					value: commitWorkspacePatch,
					enumerable: false,
					configurable: true,
					writable: true,
				});
				return workspace;
			};

			const getWorkspace = () => {
				const next = liveWorkspace && typeof liveWorkspace === "object" && !Array.isArray(liveWorkspace) ? liveWorkspace : Object.create(null);
				if (typeof executionState.leafBurstProtocolEnabled === "boolean") {
					const meta = next.meta && typeof next.meta === "object" && !Array.isArray(next.meta)
						? (next.meta as Record<string, unknown>)
						: (next.meta = { version: 1 });
					meta.leafBurstProtocolEnabled = executionState.leafBurstProtocolEnabled;
				}
				liveWorkspace = attachWorkspaceCommitHelper(prepareWorkspaceObject(next));
				workspaceInitialized = true;
				return liveWorkspace;
			};

			const buildContextView = () => {
				const base =
					executionState.runtimeContext && typeof executionState.runtimeContext === "object" && !Array.isArray(executionState.runtimeContext)
						? structuredClone(executionState.runtimeContext)
						: { messages: [] };
				const workspace = liveWorkspace && typeof liveWorkspace === "object" && !Array.isArray(liveWorkspace)
					? sanitizeWorkspaceForPersistence(prepareWorkspaceObject(liveWorkspace))
					: base.workspace;
				const activeContext = workspace && typeof workspace === "object" && !Array.isArray(workspace)
					? workspace.activeContext
					: base.activeContext;
				const artifactSummaries = workspace && typeof workspace === "object" && !Array.isArray(workspace)
					? workspace.childArtifactSummaries
					: base.artifactSummaries;
				const retention = workspace && typeof workspace === "object" && !Array.isArray(workspace)
					? workspace.retention
					: base.retention;
				const parentState = sandbox.parentState && typeof sandbox.parentState === "object" && !Array.isArray(sandbox.parentState)
					? structuredClone(sandbox.parentState)
					: base.parentState;
				const inputState = sandbox.input && typeof sandbox.input === "object" && !Array.isArray(sandbox.input)
					? structuredClone(sandbox.input)
					: base.input;
				return {
					...base,
					messages: Array.isArray(base.messages) ? base.messages : [],
					...(workspace !== undefined ? { workspace } : {}),
					...(activeContext !== undefined ? { activeContext } : {}),
					...(artifactSummaries !== undefined ? { artifactSummaries } : {}),
					...(retention !== undefined ? { retention } : {}),
					...(parentState !== undefined ? { parentState } : {}),
					...(inputState !== undefined ? { input: inputState } : {}),
					...(base.compiledContext !== undefined ? { compiledContext: base.compiledContext } : {}),
				};
			};

			const buildHistoryView = () => Array.isArray(executionState.history) ? structuredClone(executionState.history) : [];

			const assertRuntimeSubcallsAllowed = (queryMode: "simple" | "recursive") => {
				if (executionState.allowRuntimeSubcalls === false) {
					throw new Error(
						`${queryMode === "simple" ? "Simple" : "Recursive"} child-query API is disabled in this execution mode. Re-enable by switching externalization kernel mode.`,
					);
				}
			};
			const incrementAttemptedQueryCounters = (queryMode: "simple" | "recursive") => {
				if (queryMode === "simple") {
					executionState.attemptedSimpleQueryCount += 1;
				} else {
					executionState.attemptedRecursiveQueryCount += 1;
				}
			};
			const incrementQueryCounters = (queryMode: "simple" | "recursive") => {
				if (queryMode === "simple") {
					executionState.simpleQueryCount += 1;
				} else {
					executionState.recursiveQueryCount += 1;
				}
			};

			const callQuery = async (input: unknown, queryMode: "simple" | "recursive") => {
				assertRuntimeSubcallsAllowed(queryMode);
				const nextInput = attachRuntimeContextToInput(input, sandbox, queryMode);
				if (nextInput && typeof nextInput === "object" && !Array.isArray(nextInput)) {
					const modelSelector = (nextInput as Record<string, unknown>).model;
					if (typeof modelSelector === "string" && modelSelector.trim().length > 0) {
						executionState.submodelOverrideCount += 1;
					}
				}
				incrementQueryCounters(queryMode);
				const value = await callParent("llmQuery", { input: nextInput });
				const { publicValue, childArtifact } = stripInternalLlmQueryResult(value);
				if (childArtifact) mergeChildArtifactIntoWorkspace(sandbox, childArtifact);
				return publicValue;
			};

			const runLimited = async (inputs: unknown[], limit: number, queryMode: "simple" | "recursive") => {
				const results = new Array(inputs.length);
				let cursor = 0;
				const workerCount = Math.min(limit, inputs.length);
				await Promise.all(
					Array.from({ length: workerCount }, async () => {
						while (cursor < inputs.length) {
							const index = cursor++;
							results[index] = await callQuery(inputs[index], queryMode);
						}
					}),
				);
				return results;
			};

			const defineReadonlyValue = (key: string, getter: () => unknown) => {
				Object.defineProperty(sandbox, key, {
					enumerable: true,
					configurable: true,
					get() {
						const value = getter();
						return canClone(value) ? structuredClone(value) : value;
					},
					set() {
						throw new Error(`${key} is read-only in the RLM runtime`);
					},
				});
			};

			for (const [key, value] of Object.entries(runtimeBindings)) {
				if (key === "workspace") continue;
				sandbox[key] = value;
			}
			Object.defineProperty(sandbox, "workspace", {
				enumerable: true,
				configurable: true,
				get() {
					return getWorkspace();
				},
				set(value) {
					const nextWorkspace = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : Object.create(null);
					liveWorkspace = nextWorkspace;
					attachWorkspaceCommitHelper(prepareWorkspaceObject(nextWorkspace));
					workspaceInitialized = true;
				},
			});
			defineReadonlyValue("context", buildContextView);
			defineReadonlyValue("history", buildHistoryView);
			const historyView = buildHistoryView();
			for (let index = 0; index < historyView.length; index += 1) {
				defineReadonlyValue(`history_${index}`, () => buildHistoryView()[index]);
			}
			sandbox.console = consoleProxy;
			sandbox.inspectGlobals = () => inspect();
			sandbox.SHOW_VARS = () => {
				executionState.showVarsCount += 1;
				return buildInspectionFromSource(sandbox, isUserBindingKey);
			};
			sandbox.llmQuery = async (input: unknown) => {
				incrementAttemptedQueryCounters("recursive");
				assertRuntimeSubcallsAllowed("recursive");
				return callQuery(input, "recursive");
			};
			sandbox.llm_query = async (input: unknown, options: unknown) => {
				incrementAttemptedQueryCounters("simple");
				assertRuntimeSubcallsAllowed("simple");
				return callQuery(normalizeRuntimeQueryInput(input, options as Record<string, unknown> | undefined, "simple"), "simple");
			};
			sandbox.rlm_query = async (input: unknown, options: unknown) => {
				incrementAttemptedQueryCounters("recursive");
				assertRuntimeSubcallsAllowed("recursive");
				return callQuery(normalizeRuntimeQueryInput(input, options as Record<string, unknown> | undefined, "recursive"), "recursive");
			};
			sandbox.llm_query_batched = async (items: unknown, sharedOptions: unknown) => {
				executionState.attemptedSimpleBatchCount += 1;
				assertRuntimeSubcallsAllowed("simple");
				executionState.simpleBatchCount += 1;
				const inputs = normalizeRuntimeBatchInputs(items, sharedOptions as Record<string, unknown> | undefined, "simple");
				return runLimited(inputs, SIMPLE_BATCH_CONCURRENCY, "simple");
			};
			sandbox.rlm_query_batched = async (items: unknown, sharedOptions: unknown) => {
				executionState.attemptedRecursiveBatchCount += 1;
				assertRuntimeSubcallsAllowed("recursive");
				executionState.recursiveBatchCount += 1;
				const inputs = normalizeRuntimeBatchInputs(items, sharedOptions as Record<string, unknown> | undefined, "recursive");
				return runLimited(inputs, RECURSIVE_BATCH_CONCURRENCY, "recursive");
			};
			sandbox.final = (value: unknown) => {
				finalState.value = value;
				return value;
			};
			sandbox.FINAL = (value: unknown) => {
				executionState.finalAliasUsed = true;
				finalState.value = value;
				return value;
			};
			sandbox.FINAL_VAR = (nameOrValue: unknown) => {
				executionState.finalVarAliasUsed = true;
				if (typeof nameOrValue === "string") {
					if (!(nameOrValue in sandbox)) throw new Error(`FINAL_VAR could not find binding: ${nameOrValue}`);
					finalState.value = sandbox[nameOrValue];
					return finalState.value;
				}
				finalState.value = nameOrValue;
				return nameOrValue;
			};
			sandbox.globalThis = sandbox;
			for (const key of DANGEROUS_GLOBALS) sandbox[key] = undefined;
			return {
				sandbox,
				getPersistableWorkspace: () => {
					if (!workspaceInitialized) return undefined;
					const workspace = getWorkspace();
					refreshWorkspaceProjection(workspace);
					return sanitizeWorkspaceForPersistence(workspace);
				},
				getWorkspaceState: () => {
					if (!workspaceInitialized) return undefined;
					return buildWorkspaceState(getWorkspace());
				},
			};
		};

		const persistSandbox = (sandbox: Record<string, unknown>, workspaceValue?: unknown) => {
			for (const key of Object.keys(runtimeBindings)) delete runtimeBindings[key];
			for (const key of Object.keys(sandbox)) {
				if (key !== "workspace" && isHelperKey(key)) continue;
				if (key === "workspace" && workspaceValue === undefined) continue;
				const value = key === "workspace" ? workspaceValue : sandbox[key];
				if (!canClone(value)) continue;
				runtimeBindings[key] = structuredClone(value);
			}
		};

		const stableSerialize = (value: unknown) => {
			try {
				return JSON.stringify(value, (_key: string, inner: unknown) => {
					if (typeof inner === "function") return "[Function]";
					if (inner instanceof Map) return { __type: "Map", entries: Array.from(inner.entries()) };
					if (inner instanceof Set) return { __type: "Set", values: Array.from(inner.values()) };
					if (inner instanceof Date) return inner.toISOString();
					return inner;
				});
			} catch {
				return serializePreview(value);
			}
		};

		const collectPersistableBindings = () => {
			const bindings = Object.create(null) as Record<string, unknown>;
			for (const [key, value] of Object.entries(runtimeBindings)) {
				const nextValue = key === "workspace" ? sanitizeWorkspaceForPersistence(value) : value;
				if (!canClone(nextValue)) continue;
				bindings[key] = structuredClone(nextValue);
			}
			return bindings;
		};

		const computeBindingDelta = (before: Record<string, unknown>, after: Record<string, unknown>) => {
			const beforeKeys = Object.keys(before);
			const afterKeys = Object.keys(after);
			let runtimeNewBindingCount = 0;
			let runtimeUpdatedBindingCount = 0;
			for (const key of afterKeys) {
				if (!(key in before)) {
					runtimeNewBindingCount += 1;
					continue;
				}
				if (stableSerialize(before[key]) !== stableSerialize(after[key])) runtimeUpdatedBindingCount += 1;
			}
			return {
				runtimeBindingCountBefore: beforeKeys.length,
				runtimeBindingCountAfter: afterKeys.length,
				runtimeNewBindingCount,
				runtimeUpdatedBindingCount,
			};
		};

		const runCode = async (
			code: string,
			input: {
				turnIndex?: number;
				runtimeContext?: Record<string, unknown>;
				history?: Array<Record<string, unknown>>;
				leafBurstProtocolEnabled?: boolean;
				allowRuntimeSubcalls?: boolean;
			} = {},
		) => {
			const logs: string[] = [];
			const finalState = { value: undefined };
			const bindingsBefore = collectPersistableBindings();
			const executionState = {
				turnIndex: input.turnIndex,
				leafBurstProtocolEnabled: input.leafBurstProtocolEnabled,
				allowRuntimeSubcalls: input.allowRuntimeSubcalls !== false,
				commitResults: [] as Array<Record<string, unknown>>,
				runtimeContext: input.runtimeContext,
				history: input.history,
				attemptedSimpleQueryCount: 0,
				attemptedSimpleBatchCount: 0,
				attemptedRecursiveQueryCount: 0,
				attemptedRecursiveBatchCount: 0,
				simpleQueryCount: 0,
				simpleBatchCount: 0,
				recursiveQueryCount: 0,
				recursiveBatchCount: 0,
				submodelOverrideCount: 0,
				showVarsCount: 0,
				finalAliasUsed: false,
				finalVarAliasUsed: false,
			};
			const { sandbox, getPersistableWorkspace, getWorkspaceState } = createSandbox(createConsoleProxy(logs), finalState, executionState);
			try {
				const context = vm.createContext(sandbox, {
					codeGeneration: { strings: false, wasm: false },
				});
				const script = new vm.Script(`(async () => {\n${code}\n})()`, {
					filename: "rlm-exec.js",
				});
				const result = await Promise.resolve(script.runInContext(context, { timeout: VM_SYNC_TIMEOUT_MS }));
				persistSandbox(sandbox, getPersistableWorkspace());
				const inspection = inspect();
				const stdout = logs.join("\n").slice(0, MAX_STDOUT_CHARS);
				const bindingDelta = computeBindingDelta(bindingsBefore, collectPersistableBindings());
				return {
					ok: true,
					stdout,
					returnValuePreview: result === undefined ? undefined : serializePreview(result),
					inspection,
					snapshot: snapshot(),
					finalValue: finalState.value,
					commitCount: executionState.commitResults.length,
					commitResults: executionState.commitResults,
					workspaceState: getWorkspaceState(),
					attemptedSimpleQueryCount: executionState.attemptedSimpleQueryCount,
					attemptedSimpleBatchCount: executionState.attemptedSimpleBatchCount,
					attemptedRecursiveQueryCount: executionState.attemptedRecursiveQueryCount,
					attemptedRecursiveBatchCount: executionState.attemptedRecursiveBatchCount,
					simpleQueryCount: executionState.simpleQueryCount,
					simpleBatchCount: executionState.simpleBatchCount,
					recursiveQueryCount: executionState.recursiveQueryCount,
					recursiveBatchCount: executionState.recursiveBatchCount,
					submodelOverrideCount: executionState.submodelOverrideCount,
					showVarsCount: executionState.showVarsCount,
					finalAliasUsed: executionState.finalAliasUsed,
					finalVarAliasUsed: executionState.finalVarAliasUsed,
					contextMessageCount: Array.isArray(executionState.runtimeContext?.messages) ? executionState.runtimeContext.messages.length : 0,
					historyCount: Array.isArray(executionState.history) ? executionState.history.length : 0,
					...bindingDelta,
				};
			} catch (error: unknown) {
				persistSandbox(sandbox, getPersistableWorkspace());
				const inspection = inspect();
				const stdout = logs.join("\n").slice(0, MAX_STDOUT_CHARS);
				const bindingDelta = computeBindingDelta(bindingsBefore, collectPersistableBindings());
				return {
					ok: false,
					stdout,
					error: formatError(error),
					inspection,
					snapshot: snapshot(),
					finalValue: finalState.value,
					commitCount: executionState.commitResults.length,
					commitResults: executionState.commitResults,
					workspaceState: getWorkspaceState(),
					attemptedSimpleQueryCount: executionState.attemptedSimpleQueryCount,
					attemptedSimpleBatchCount: executionState.attemptedSimpleBatchCount,
					attemptedRecursiveQueryCount: executionState.attemptedRecursiveQueryCount,
					attemptedRecursiveBatchCount: executionState.attemptedRecursiveBatchCount,
					simpleQueryCount: executionState.simpleQueryCount,
					simpleBatchCount: executionState.simpleBatchCount,
					recursiveQueryCount: executionState.recursiveQueryCount,
					recursiveBatchCount: executionState.recursiveBatchCount,
					submodelOverrideCount: executionState.submodelOverrideCount,
					showVarsCount: executionState.showVarsCount,
					finalAliasUsed: executionState.finalAliasUsed,
					finalVarAliasUsed: executionState.finalVarAliasUsed,
					contextMessageCount: Array.isArray(executionState.runtimeContext?.messages) ? executionState.runtimeContext.messages.length : 0,
					historyCount: Array.isArray(executionState.history) ? executionState.history.length : 0,
					...bindingDelta,
				};
			}
		};

		parentPort.on("message", async (message: Record<string, unknown>) => {
			if (message?.type === "rpc_result") {
				const pending = pendingRpc.get(message.rpcId as string);
				if (!pending) return;
				pendingRpc.delete(message.rpcId as string);
				if (message.ok) pending.resolve(message.value);
				else pending.reject(new Error((message.error as string) || "RPC failed"));
				return;
			}

			if (message?.type !== "request") return;
			const requestId = message.requestId as string;
			try {
				let value: unknown;
				switch (message.method) {
					case "exec":
						value = await runCode((message.payload as { code: string; turnIndex?: number; runtimeContext?: Record<string, unknown>; history?: Array<Record<string, unknown>>; leafBurstProtocolEnabled?: boolean }).code, {
							turnIndex: (message.payload as { code: string; turnIndex?: number; runtimeContext?: Record<string, unknown>; history?: Array<Record<string, unknown>>; leafBurstProtocolEnabled?: boolean }).turnIndex,
							runtimeContext: (message.payload as { code: string; turnIndex?: number; runtimeContext?: Record<string, unknown>; history?: Array<Record<string, unknown>>; leafBurstProtocolEnabled?: boolean }).runtimeContext,
							history: (message.payload as { code: string; turnIndex?: number; runtimeContext?: Record<string, unknown>; history?: Array<Record<string, unknown>>; leafBurstProtocolEnabled?: boolean }).history,
							leafBurstProtocolEnabled: (message.payload as { code: string; turnIndex?: number; runtimeContext?: Record<string, unknown>; history?: Array<Record<string, unknown>>; leafBurstProtocolEnabled?: boolean }).leafBurstProtocolEnabled,
							allowRuntimeSubcalls: (message.payload as { allowRuntimeSubcalls?: boolean }).allowRuntimeSubcalls,
						});
						break;
					case "inspect":
						value = inspect();
						break;
					case "restore":
						value = restore((message.payload as { snapshot: { bindings?: Record<string, unknown> } }).snapshot);
						break;
					case "reset":
						value = reset();
						break;
					default:
						throw new Error(`Unknown worker method: ${String(message.method)}`);
				}
				parentPort.postMessage({ type: "response", requestId, ok: true, value });
			} catch (error: unknown) {
				parentPort.postMessage({
					type: "response",
					requestId,
					ok: false,
					error: formatError(error),
				});
			}
		});
	}

	return `const __name = (fn) => fn;\n(${workerMain.toString()})();`;
}

export class RuntimeSession {
	private worker: Worker;
	private requestCounter = 0;
	private pending = new Map<string, PendingRequest>();
	private currentLlmQuery?: LlmQueryFunction;
	private lastSnapshot: RuntimeSnapshot = { version: 1, bindings: {}, entries: [] };

	constructor() {
		this.worker = this.createWorker();
	}

	private createWorker() {
		const worker = new Worker(createWorkerSource(), { eval: true });
		worker.on("message", (message) => this.onMessage(message));
		worker.on("error", (error) => {
			for (const pending of this.pending.values()) {
				if (pending.timeout) clearTimeout(pending.timeout);
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
			this.pending.clear();
		});
		return worker;
	}

	private async restart(snapshot?: RuntimeSnapshot) {
		try {
			await this.worker.terminate();
		} catch {
			// ignore
		}
		this.worker = this.createWorker();
		if (snapshot) await this.restore(snapshot, { force: true });
	}

	private onMessage(message: any) {
		if (message?.type === "response") {
			const pending = this.pending.get(message.requestId);
			if (!pending) return;
			this.pending.delete(message.requestId);
			if (pending.timeout) clearTimeout(pending.timeout);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(new Error(message.error || "Worker request failed"));
			return;
		}

		if (message?.type === "rpc" && message.method === "llmQuery") {
			void (async () => {
				try {
					if (!this.currentLlmQuery) throw new Error("llmQuery is not available in this execution context");
					const value = await this.currentLlmQuery(message.payload?.input);
					this.worker.postMessage({ type: "rpc_result", rpcId: message.rpcId, ok: true, value });
				} catch (error) {
					this.worker.postMessage({
						type: "rpc_result",
						rpcId: message.rpcId,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})();
		}
	}

	private request<T>(method: string, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
		const requestId = `req-${++this.requestCounter}`;
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject };
			if (timeoutMs > 0) {
				pending.timeout = setTimeout(() => {
					this.pending.delete(requestId);
					reject(new Error(`Runtime ${method} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}
			this.pending.set(requestId, pending);
			this.worker.postMessage({ type: "request", requestId, method, payload });
		});
	}

	async exec(
		code: string,
		hooks?: {
			llmQuery?: LlmQueryFunction;
			turnIndex?: number;
			runtimeContext?: RlmRuntimeContext;
			history?: RlmHistoryTurn[];
			leafBurstProtocolEnabled?: boolean;
			externalizationKernel?: RlmExternalizationKernelMode;
		},
	): Promise<ExecResult> {
		this.currentLlmQuery = hooks?.llmQuery;
		const previousSnapshot = this.lastSnapshot;
		const allowRuntimeSubcalls = (hooks?.externalizationKernel ?? "current") !== "no-subcalls";
		try {
			const result = await this.request<ExecResult>(
				"exec",
				{
					code,
					turnIndex: hooks?.turnIndex,
					runtimeContext: hooks?.runtimeContext,
					history: hooks?.history,
					leafBurstProtocolEnabled: hooks?.leafBurstProtocolEnabled,
					allowRuntimeSubcalls,
				},
				EXEC_TIMEOUT_MS,
			);
			this.lastSnapshot = result.snapshot;
			return result;
		} catch (error) {
			await this.restart(previousSnapshot);
			throw error;
		} finally {
			this.currentLlmQuery = undefined;
		}
	}

	async inspect(): Promise<GlobalsInspection> {
		return this.request<GlobalsInspection>("inspect");
	}

	private async requestRestore(snapshot: RuntimeSnapshot) {
		return this.request<{ inspection: GlobalsInspection; snapshot: RuntimeSnapshot }>(
			"restore",
			{
				snapshot,
			},
			RESTORE_TIMEOUT_MS,
		);
	}

	async restore(snapshot: RuntimeSnapshot, options?: { force?: boolean }): Promise<void> {
		if (!options?.force && isDeepStrictEqual(snapshot, this.lastSnapshot)) return;
		const previousSnapshot = this.lastSnapshot;
		try {
			const result = await this.requestRestore(snapshot);
			this.lastSnapshot = result.snapshot;
			return;
		} catch {
			try {
				await this.restart();
			} catch {
				// Best effort; the retry below will surface the real error if recovery fails.
			}
		}
		try {
			const result = await this.requestRestore(snapshot);
			this.lastSnapshot = result.snapshot;
		} catch (retryError) {
			try {
				await this.restart(previousSnapshot);
			} catch {
				// Preserve the retry failure; recovery is best effort.
			}
			throw retryError;
		}
	}

	async reset(): Promise<void> {
		const result = await this.request<{ inspection: GlobalsInspection; snapshot: RuntimeSnapshot }>("reset");
		this.lastSnapshot = result.snapshot;
	}

	getSnapshot(): RuntimeSnapshot {
		return this.lastSnapshot;
	}

	async dispose(): Promise<void> {
		for (const pending of this.pending.values()) {
			if (pending.timeout) clearTimeout(pending.timeout);
			pending.reject(new Error("Runtime disposed"));
		}
		this.pending.clear();
		await this.worker.terminate();
	}
}

export class RuntimeManager {
	private sessions = new Map<string, RuntimeSession>();

	getOrCreate(key: string): RuntimeSession {
		let session = this.sessions.get(key);
		if (!session) {
			session = new RuntimeSession();
			this.sessions.set(key, session);
		}
		return session;
	}

	async dispose(key: string): Promise<void> {
		const session = this.sessions.get(key);
		if (!session) return;
		this.sessions.delete(key);
		await session.dispose();
	}

	async disposeAll(): Promise<void> {
		const sessions = Array.from(this.sessions.values());
		this.sessions.clear();
		await Promise.all(sessions.map((session) => session.dispose()));
	}
}
