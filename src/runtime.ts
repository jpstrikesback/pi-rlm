import { Worker } from "node:worker_threads";
import type { ExecResult, GlobalsInspection, LlmQueryFunction, RuntimeSnapshot } from "./types.js";

type PendingRequest = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timeout?: ReturnType<typeof setTimeout>;
};

const EXEC_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 5000;

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
		const INTERNAL_CHILD_ARTIFACT_KEY = "__rlmInternal";
		const INTERNAL_LLM_QUERY_CONTEXT_KEY = "__rlmRuntimeContext";
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

		const inspect = () => {
			const entries = Object.keys(runtimeBindings)
				.sort((a, b) => a.localeCompare(b))
				.map((name) => {
					const value = runtimeBindings[name];
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

		const snapshot = () => {
			const inspection = inspect();
			const bindings = Object.create(null);
			for (const key of Object.keys(runtimeBindings)) {
				const value = runtimeBindings[key];
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
			const workspace = current && typeof current === "object" && !Array.isArray(current) ? current : Object.create(null);
			if (!Array.isArray(workspace.childArtifacts)) workspace.childArtifacts = [];
			if (!Array.isArray(workspace.childArtifactSummaries)) workspace.childArtifactSummaries = [];
			if (!workspace.artifactIndex || typeof workspace.artifactIndex !== "object" || Array.isArray(workspace.artifactIndex)) {
				workspace.artifactIndex = Object.create(null);
			}
			if (!workspace.artifactIndex.byId || typeof workspace.artifactIndex.byId !== "object" || Array.isArray(workspace.artifactIndex.byId)) {
				workspace.artifactIndex.byId = Object.create(null);
			}
			if (!workspace.artifactIndex.byTag || typeof workspace.artifactIndex.byTag !== "object" || Array.isArray(workspace.artifactIndex.byTag)) {
				workspace.artifactIndex.byTag = Object.create(null);
			}
			if (!workspace.artifactIndex.byFile || typeof workspace.artifactIndex.byFile !== "object" || Array.isArray(workspace.artifactIndex.byFile)) {
				workspace.artifactIndex.byFile = Object.create(null);
			}
			if (!Array.isArray(workspace.artifactIndex.recentIds)) workspace.artifactIndex.recentIds = [];
			if (!workspace.meta || typeof workspace.meta !== "object" || Array.isArray(workspace.meta)) workspace.meta = { version: 1 };
			workspace.meta.version = 1;
			refreshWorkspaceProjection(workspace);
			sandbox.workspace = workspace;
			return workspace;
		};

		const normalizeStringList = (value: unknown) =>
			Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : undefined;

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

		const attachRuntimeContextToInput = (input: unknown, sandbox: Record<string, unknown>) => {
			if (!input || typeof input !== "object" || Array.isArray(input)) return input;
			const next = Object.assign(Object.create(null), input as Record<string, unknown>);
			const workspace = sandbox.workspace;
			if (workspace && typeof workspace === "object" && !Array.isArray(workspace) && canClone(workspace)) {
				next[INTERNAL_LLM_QUERY_CONTEXT_KEY] = { workspace: structuredClone(workspace) };
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

		const createSandbox = (consoleProxy: ReturnType<typeof createConsoleProxy>, finalState: { value: unknown }) => {
			const sandbox = Object.create(null);
			for (const [key, value] of Object.entries(runtimeBindings)) {
				sandbox[key] = value;
			}
			sandbox.console = consoleProxy;
			sandbox.inspectGlobals = () => inspect();
			sandbox.llmQuery = async (input: unknown) => {
				const value = await callParent("llmQuery", { input: attachRuntimeContextToInput(input, sandbox) });
				const { publicValue, childArtifact } = stripInternalLlmQueryResult(value);
				if (childArtifact) mergeChildArtifactIntoWorkspace(sandbox, childArtifact);
				return publicValue;
			};
			sandbox.final = (value: unknown) => {
				finalState.value = value;
				return value;
			};
			sandbox.globalThis = sandbox;
			for (const key of DANGEROUS_GLOBALS) sandbox[key] = undefined;
			return sandbox;
		};

		const persistSandbox = (sandbox: Record<string, unknown>) => {
			if (sandbox.workspace && typeof sandbox.workspace === "object" && !Array.isArray(sandbox.workspace)) {
				refreshWorkspaceProjection(sandbox.workspace as Record<string, unknown>);
			}
			for (const key of Object.keys(runtimeBindings)) delete runtimeBindings[key];
			for (const key of Object.keys(sandbox)) {
				if (RESERVED_KEYS.has(key)) continue;
				const value = sandbox[key];
				if (!canClone(value)) continue;
				runtimeBindings[key] = structuredClone(value);
			}
		};

		const runCode = async (code: string) => {
			const logs: string[] = [];
			const finalState = { value: undefined };
			const sandbox = createSandbox(createConsoleProxy(logs), finalState);
			try {
				const context = vm.createContext(sandbox, {
					codeGeneration: { strings: false, wasm: false },
				});
				const script = new vm.Script(`(async () => {\n${code}\n})()`, {
					filename: "rlm-exec.js",
				});
				const result = await Promise.resolve(script.runInContext(context, { timeout: VM_SYNC_TIMEOUT_MS }));
				persistSandbox(sandbox);
				const inspection = inspect();
				const stdout = logs.join("\n").slice(0, MAX_STDOUT_CHARS);
				return {
					ok: true,
					stdout,
					returnValuePreview: result === undefined ? undefined : serializePreview(result),
					inspection,
					snapshot: snapshot(),
					finalValue: finalState.value,
				};
			} catch (error: unknown) {
				const inspection = inspect();
				const stdout = logs.join("\n").slice(0, MAX_STDOUT_CHARS);
				return {
					ok: false,
					stdout,
					error: formatError(error),
					inspection,
					snapshot: snapshot(),
					finalValue: finalState.value,
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
						value = await runCode((message.payload as { code: string }).code);
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
		if (snapshot) await this.restore(snapshot);
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

	async exec(code: string, hooks?: { llmQuery?: LlmQueryFunction }): Promise<ExecResult> {
		this.currentLlmQuery = hooks?.llmQuery;
		const previousSnapshot = this.lastSnapshot;
		try {
			const result = await this.request<ExecResult>("exec", { code }, EXEC_TIMEOUT_MS);
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

	async restore(snapshot: RuntimeSnapshot): Promise<void> {
		const result = await this.request<{ inspection: GlobalsInspection; snapshot: RuntimeSnapshot }>("restore", {
			snapshot,
		});
		this.lastSnapshot = result.snapshot;
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
