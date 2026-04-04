import { isDeepStrictEqual } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	buildRlmModeAppendix,
	DEFAULT_RLM_PROMPT_MODE,
	findRlmPromptMode,
	getRlmPromptModeLabel,
	RLM_PROMPT_MODE_TYPE,
} from "./prompt-mode.js";
import { parseRlmCommandAction } from "./rlm-command.js";
import { runChildQuery } from "./recursion.js";
import { composeRuntimeSnapshot, findBootstrapSnapshot, findLatestSnapshot, findLatestWorkspace, getSessionRuntimeKey, RLM_WORKSPACE_TYPE } from "./restore.js";
import { RuntimeManager } from "./runtime.js";
import { collectRlmSessionStats } from "./stats.js";
import type {
	ExecResult,
	GlobalsInspection,
	LlmQueryFunction,
	LlmQueryRequest,
	RlmChildActivity,
	RlmChildProgressEvent,
	RlmPromptMode,
	RlmSessionStats,
	RlmToolDetails,
	RuntimeSnapshot,
} from "./types.js";

const RLM_MODE_TYPE = "rlm-mode";
const PINK = "\x1b[38;5;213m";
const RESET = "\x1b[0m";
const MAX_VISIBLE_CHILDREN = 8;
const LIVE_UPDATE_THROTTLE_MS = 120;

function safePreview(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text ?? String(value);
	} catch {
		return String(value);
	}
}

function formatExecResult(result: ExecResult): string {
	const parts: string[] = [];
	parts.push(result.ok ? "Execution succeeded." : "Execution failed.");
	if (result.error) parts.push(`\nerror:\n${result.error}`);
	if (result.stdout) parts.push(`\nstdout:\n${result.stdout}`);
	if (result.returnValuePreview) parts.push(`\nreturn:\n${result.returnValuePreview}`);
	if (result.finalValue !== undefined) parts.push(`\nfinal:\n${safePreview(result.finalValue)}`);
	parts.push(`\nruntime:\n${result.inspection.table}`);
	return parts.join("\n");
}

function formatInspection(inspection: GlobalsInspection): string {
	return `RLM runtime\n\n${inspection.table}`;
}

function findRlmModeEnabled(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== RLM_MODE_TYPE) continue;
		const data = entry.data as { enabled?: boolean } | undefined;
		return !!data?.enabled;
	}
	return false;
}

function formatStats(stats: RlmSessionStats): string {
	const mode = getRlmPromptModeLabel(stats.promptMode);
	const child = stats.childTurns > 0 ? `${stats.childQueryCount}/${stats.childTurns}t` : `${stats.childQueryCount}`;
	return `RLM ${mode} · d ${stats.depth}/${stats.maxDepth} · exec ${stats.execCount} · child ${child} · vars ${stats.runtimeVarCount} · leaf ${stats.leafToolCount}`;
}

function applyModeWidget(ctx: ExtensionContext, enabled: boolean, promptMode: RlmPromptMode, root: boolean) {
	if (!root || !ctx.hasUI) return;
	ctx.ui.setWidget(
		"rlm-mode",
		enabled ? [`${PINK}RLM MODE${RESET} ${getRlmPromptModeLabel(promptMode)} recursive runtime active`] : undefined,
		{ placement: "aboveEditor" },
	);
}

function applyStatus(
	ctx: ExtensionContext,
	enabled: boolean,
	promptMode: RlmPromptMode,
	root: boolean,
	stats?: RlmSessionStats,
) {
	if (!root || !ctx.hasUI) return;
	if (!enabled) {
		ctx.ui.setStatus("rlm-stats", undefined);
		return;
	}
	const nextStats = stats ?? collectRlmSessionStats(ctx, { depth: 0, maxDepth: 0 });
	const theme = ctx.ui.theme;
	const header = theme.fg("accent", `RLM ${getRlmPromptModeLabel(promptMode)}`);
	const details = theme.fg(
		"dim",
		` · d ${nextStats.depth}/${nextStats.maxDepth} · exec ${nextStats.execCount} · child ${nextStats.childTurns > 0 ? `${nextStats.childQueryCount}/${nextStats.childTurns}t` : `${nextStats.childQueryCount}`} · vars ${nextStats.runtimeVarCount} · leaf ${nextStats.leafToolCount}`,
	);
	ctx.ui.setStatus("rlm-stats", header + details);
}

async function restoreRuntime(manager: RuntimeManager, initializedKeys: Set<string>, ctx: ExtensionContext) {
	const key = getSessionRuntimeKey(ctx);
	const runtime = manager.getOrCreate(key);
	const workspace = findLatestWorkspace(ctx);
	const restoredSnapshot = composeRuntimeSnapshot(
		findLatestSnapshot(ctx) ?? findBootstrapSnapshot(ctx),
		workspace && workspace !== null ? markRunningChildrenInterrupted(workspace) : workspace,
	);
	await runtime.restore(restoredSnapshot);
	initializedKeys.add(key);
	return runtime;
}

async function getRuntime(manager: RuntimeManager, initializedKeys: Set<string>, ctx: ExtensionContext) {
	const key = getSessionRuntimeKey(ctx);
	if (!initializedKeys.has(key)) return restoreRuntime(manager, initializedKeys, ctx);
	return manager.getOrCreate(key);
}

function computeStats(ctx: ExtensionContext, options: { depth: number; maxDepth: number }, snapshot?: RuntimeSnapshot) {
	return collectRlmSessionStats(ctx, options, snapshot);
}

function normalizeWorkspaceBinding(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (structuredClone(value) as Record<string, unknown>) : undefined;
}

function markRunningChildrenInterrupted(workspace: Record<string, unknown>): Record<string, unknown> {
	const next = structuredClone(workspace) as Record<string, unknown>;
	const children = next.children;
	if (!Array.isArray(children)) return next;
	next.children = children.map((child) => {
		if (!child || typeof child !== "object") return child;
		const current = child as Record<string, unknown>;
		return current.status === "running" ? { ...current, status: "interrupted" } : current;
	});
	return next;
}

function getVisibleChildren(children: Map<string, RlmChildActivity>): RlmChildActivity[] {
	return Array.from(children.values()).slice(-MAX_VISIBLE_CHILDREN);
}

function applyChildProgress(children: Map<string, RlmChildActivity>, event: RlmChildProgressEvent) {
	switch (event.type) {
		case "start":
			children.set(event.childId, {
				childId: event.childId,
				role: event.role,
				promptPreview: event.promptPreview,
				status: "running",
				turns: 0,
			});
			return;
		case "turn_end": {
			const child = children.get(event.childId);
			if (!child) return;
			child.turns = event.turns;
			return;
		}
		case "tool_start": {
			const child = children.get(event.childId);
			if (!child) return;
			child.activeTool = event.toolName;
			return;
		}
		case "tool_end": {
			const child = children.get(event.childId);
			if (!child) return;
			if (child.activeTool === event.toolName) child.activeTool = undefined;
			return;
		}
		case "end": {
			const child = children.get(event.childId);
			if (!child) return;
			child.status = event.ok ? "done" : "error";
			child.turns = event.turns;
			child.activeTool = undefined;
			child.summary = event.summary;
			return;
		}
		case "error": {
			const child = children.get(event.childId);
			if (!child) return;
			child.status = "error";
			child.activeTool = undefined;
			child.error = event.error;
			return;
		}
	}
}

function renderChildLine(child: RlmChildActivity, theme: any, expanded: boolean): string {
	const status =
		child.status === "running"
			? theme.fg("warning", "running")
			: child.status === "done"
				? theme.fg("success", "done")
				: theme.fg("error", "error");
	let text = `- ${theme.fg("accent", child.role)} ${theme.fg("dim", child.promptPreview)}`;
	text += `\n  ${status}${theme.fg("dim", ` · turn ${child.turns}`)}`;
	if (child.activeTool) text += theme.fg("muted", ` · ${child.activeTool}`);
	if (expanded && child.summary) text += `\n  ${theme.fg("muted", child.summary)}`;
	if (expanded && child.error) text += `\n  ${theme.fg("error", child.error)}`;
	return text;
}

function persistWorkspaceEntry(
	pi: ExtensionAPI,
	currentWorkspace: Record<string, unknown> | undefined,
	previousWorkspace: Record<string, unknown> | null | undefined,
) {
	const nextWorkspace = currentWorkspace ?? null;
	const lastWorkspace = previousWorkspace ?? null;
	if (isDeepStrictEqual(nextWorkspace, lastWorkspace)) return;
	pi.appendEntry(RLM_WORKSPACE_TYPE, { workspace: nextWorkspace });
}

function renderRlmExecResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: any) {
	const details = result.details as RlmToolDetails | undefined;
	const visibleChildren = details?.live?.children ?? [];
	const childSummary = details?.childQueryCount ? ` · child ${details.childQueryCount}${details.childTurns ? `/${details.childTurns}t` : ""}` : "";

	if (options.isPartial) {
		let text = theme.fg("warning", "Running RLM exec") + theme.fg("dim", childSummary);
		if (visibleChildren.length === 0) {
			text += `\n${theme.fg("muted", "(waiting for child activity)")}`;
			return new Text(text, 0, 0);
		}
		for (const child of visibleChildren) text += `\n${renderChildLine(child, theme, false)}`;
		return new Text(text, 0, 0);
	}

	const content = result.content[0];
	const contentText = content?.type === "text" ? (content.text ?? "") : "";
	const headline = contentText.startsWith("Execution failed.")
		? theme.fg("error", "Execution failed")
		: theme.fg("success", "Execution succeeded");
	let text = headline + theme.fg("dim", childSummary);
	if (visibleChildren.length > 0) {
		for (const child of visibleChildren) text += `\n${renderChildLine(child, theme, options.expanded)}`;
	}
	if (options.expanded && contentText) text += `\n\n${theme.fg("dim", contentText)}`;
	return new Text(text, 0, 0);
}

export function createRlmExtensionFactory(options: {
	depth: number;
	maxDepth: number;
	root: boolean;
	promptMode: RlmPromptMode;
}): ExtensionFactory {
	return function installRlm(pi: ExtensionAPI) {
		const manager = new RuntimeManager();
		const initializedKeys = new Set<string>();
		let rlmModeEnabled = !options.root;
		let rlmPromptMode = options.promptMode ?? DEFAULT_RLM_PROMPT_MODE;

		const persistMode = (enabled: boolean) => {
			rlmModeEnabled = enabled;
			pi.appendEntry(RLM_MODE_TYPE, { enabled });
		};

		const persistPromptMode = (mode: RlmPromptMode) => {
			rlmPromptMode = mode;
			pi.appendEntry(RLM_PROMPT_MODE_TYPE, { mode });
		};

		const refreshState = async (ctx: ExtensionContext) => {
			const runtime = await restoreRuntime(manager, initializedKeys, ctx);
			if (options.root) {
				rlmModeEnabled = findRlmModeEnabled(ctx);
				rlmPromptMode = findRlmPromptMode(ctx);
			}
			const stats = computeStats(ctx, options, runtime.getSnapshot());
			applyModeWidget(ctx, rlmModeEnabled, rlmPromptMode, options.root);
			applyStatus(ctx, rlmModeEnabled, rlmPromptMode, options.root, stats);
		};

		const restoreHandler = async (_event: unknown, ctx: ExtensionContext) => {
			await refreshState(ctx);
		};

		pi.on("session_start", restoreHandler);
		pi.on("session_before_switch", restoreHandler);
		pi.on("session_tree", restoreHandler);
		pi.on("session_before_fork", restoreHandler);
		pi.on("session_shutdown", async () => {
			await manager.disposeAll();
		});
		pi.on("turn_end", async (_event, ctx) => {
			const runtime = await getRuntime(manager, initializedKeys, ctx);
			const stats = computeStats(ctx, options, runtime.getSnapshot());
			applyStatus(ctx, rlmModeEnabled, rlmPromptMode, options.root, stats);
		});

		pi.on("before_agent_start", async (event, ctx) => {
			const runtime = await restoreRuntime(manager, initializedKeys, ctx);
			const inspection = await runtime.inspect();
			const active = !options.root || rlmModeEnabled;
			const stats = computeStats(ctx, options, runtime.getSnapshot());
			applyStatus(ctx, rlmModeEnabled, rlmPromptMode, options.root, stats);
			if (!active) return;
			return {
				systemPrompt: `${event.systemPrompt}${buildRlmModeAppendix(rlmPromptMode)}`,
				message:
					inspection.entries.length > 0
						? {
								customType: "rlm-context",
								content: `[RLM MODE ACTIVE]\n${formatStats(stats)}\n\n${inspection.table}`,
								display: false,
							}
						: undefined,
			};
		});

		pi.registerTool({
			name: "rlm_exec",
			label: "RLM Exec",
			description:
				"Execute JavaScript in a persistent runtime with live variables. Persist state by assigning to globalThis.<name>.",
			promptSnippet:
				"Use this as the persistent coordinator workspace for multi-file or multi-step tasks. Helpers: final(), inspectGlobals(), llmQuery({ prompt, ... }).",
			promptGuidelines: [
				"For multi-file or multi-step tasks, use this as the top-level coordinator workspace.",
				"Persist important state explicitly on globalThis.",
				"Track goal, plan, files, findings, open questions, and partial outputs in runtime when helpful.",
				"Use direct Pi tools as leaf actions and return here to update the workspace.",
				"Use console.log() for compact inspection, not huge dumps.",
				"Recursive child calls use exactly one form: llmQuery({ prompt, role, state, tools, budget, output }).",
				"Tools presets are read-only, coding, same, or an explicit built-in tool list.",
				"budget also accepts low, medium, or high.",
				"Use llmQuery selectively and batch related work into fewer, larger child calls.",
				"Default child tools should usually be read-only unless mutation is required.",
			],
			parameters: Type.Object({
				code: Type.String({
					description:
						"JavaScript to execute. Helpers available inside the runtime: inspectGlobals(), final(value), llmQuery({ prompt, role, state, tools, budget, output }).",
				}),
			}),
			renderCall(_args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("rlm_exec")), 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				return renderRlmExecResult(result as { content: Array<{ type: string; text?: string }>; details?: unknown }, { expanded, isPartial }, theme);
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				const previousWorkspace = findLatestWorkspace(ctx);
				let childQueryCount = 0;
				let childTurns = 0;
				let lastUpdateAt = 0;
				const children = new Map<string, RlmChildActivity>();
				const emitLiveUpdate = () => {
					const now = Date.now();
					if (now - lastUpdateAt < LIVE_UPDATE_THROTTLE_MS) return;
					lastUpdateAt = now;
					_onUpdate?.({
						content: [{ type: "text", text: "RLM exec running..." }],
						details: {
							childQueryCount,
							childTurns,
							live: {
								children: getVisibleChildren(children),
							},
						},
					});
				};
				const llmQuery: LlmQueryFunction = async (input: LlmQueryRequest) => {
					childQueryCount += 1;
					emitLiveUpdate();
					const result = await runChildQuery(input, ctx, {
						depth: options.depth + 1,
						maxDepth: options.maxDepth,
						extensionFactory: createRlmExtensionFactory({
							depth: options.depth + 1,
							maxDepth: options.maxDepth,
							root: false,
							promptMode: rlmPromptMode,
						}),
						parentActiveTools: pi.getActiveTools(),
						onProgress: (event) => {
							applyChildProgress(children, event);
							emitLiveUpdate();
						},
					});
					childTurns += result.usage?.turns ?? 0;
					emitLiveUpdate();
					return result;
				};

				emitLiveUpdate();
				const result = await runtime.exec(params.code, { llmQuery });
				persistWorkspaceEntry(pi, normalizeWorkspaceBinding(result.snapshot.bindings.workspace), previousWorkspace);

				const details: RlmToolDetails = {
					turn: ctx.sessionManager.getBranch().length,
					snapshot: result.snapshot,
					inspection: result.inspection,
					stdout: result.stdout,
					returnValuePreview: result.returnValuePreview,
					error: result.error,
					finalValue: result.finalValue,
					childQueryCount,
					childTurns,
					live: {
						children: getVisibleChildren(children),
					},
				};

				const stats = computeStats(ctx, options, result.snapshot);
				stats.childQueryCount += childQueryCount;
				stats.childTurns += childTurns;
				stats.execCount += 1;
				applyStatus(ctx, rlmModeEnabled, rlmPromptMode, options.root, stats);

				return {
					content: [{ type: "text", text: formatExecResult(result) }],
					details,
				};
			},
		});

		pi.registerTool({
			name: "rlm_inspect",
			label: "RLM Inspect",
			description: "Inspect the current persistent runtime variables.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				const inspection = await runtime.inspect();
				const stats = computeStats(ctx, options, runtime.getSnapshot());
				applyStatus(ctx, rlmModeEnabled, rlmPromptMode, options.root, stats);
				return {
					content: [{ type: "text", text: formatInspection(inspection) }],
					details: {
						snapshot: runtime.getSnapshot(),
						inspection,
					},
				};
			},
		});

		pi.registerTool({
			name: "rlm_reset",
			label: "RLM Reset",
			description: "Reset the persistent runtime and clear live variables.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				await runtime.reset();
				pi.appendEntry(RLM_WORKSPACE_TYPE, { workspace: null });
				const inspection = await runtime.inspect();
				const stats = computeStats(ctx, options, runtime.getSnapshot());
				applyStatus(ctx, rlmModeEnabled, rlmPromptMode, options.root, stats);
				return {
					content: [{ type: "text", text: "RLM runtime reset.\n\n(runtime empty)" }],
					details: {
						snapshot: runtime.getSnapshot(),
						inspection,
					},
				};
			},
		});

		if (options.root) {
			const setPromptMode = async (mode: RlmPromptMode, ctx: ExtensionCommandContext) => {
				persistPromptMode(mode);
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				const stats = computeStats(ctx, options, runtime.getSnapshot());
				applyModeWidget(ctx, rlmModeEnabled, rlmPromptMode, true);
				applyStatus(ctx, rlmModeEnabled, rlmPromptMode, true, stats);
				ctx.ui.notify(`RLM prompt mode: ${mode}`, "info");
			};

			pi.registerCommand("rlm", {
				description: "Toggle RLM mode, set mode, inspect, or reset",
				handler: async (args, ctx: ExtensionCommandContext) => {
					const action = parseRlmCommandAction(args);
					switch (action.type) {
						case "toggle": {
							persistMode(!rlmModeEnabled);
							const runtime = await getRuntime(manager, initializedKeys, ctx);
							const stats = computeStats(ctx, options, runtime.getSnapshot());
							applyModeWidget(ctx, rlmModeEnabled, rlmPromptMode, true);
							applyStatus(ctx, rlmModeEnabled, rlmPromptMode, true, stats);
							ctx.ui.notify(`RLM mode ${rlmModeEnabled ? "enabled" : "disabled"}`, "info");
							return;
						}
						case "set-mode":
							await setPromptMode(action.mode, ctx);
							return;
						case "inspect": {
							const runtime = await getRuntime(manager, initializedKeys, ctx);
							const inspection = await runtime.inspect();
							const stats = computeStats(ctx, options, runtime.getSnapshot());
							applyStatus(ctx, rlmModeEnabled, rlmPromptMode, true, stats);
							if (ctx.hasUI) await ctx.ui.editor("RLM runtime", inspection.table);
							else pi.sendMessage({ customType: "rlm-inspect", content: inspection.table, display: true });
							return;
						}
						case "reset": {
							const runtime = await getRuntime(manager, initializedKeys, ctx);
							await runtime.reset();
							pi.appendEntry("rlm-runtime", { snapshot: runtime.getSnapshot() });
							pi.appendEntry(RLM_WORKSPACE_TYPE, { workspace: null });
							const stats = computeStats(ctx, options, runtime.getSnapshot());
							applyStatus(ctx, rlmModeEnabled, rlmPromptMode, true, stats);
							ctx.ui.notify("RLM runtime reset", "info");
							return;
						}
						case "invalid":
							ctx.ui.notify("Usage: /rlm [balanced|coordinator|aggressive|inspect|reset]", "error");
							return;
					}
				},
			});
		}
	};
}
