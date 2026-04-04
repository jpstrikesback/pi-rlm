import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
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
import { findBootstrapSnapshot, findLatestSnapshot, getSessionRuntimeKey } from "./restore.js";
import { RuntimeManager } from "./runtime.js";
import { collectRlmSessionStats } from "./stats.js";
import type {
	ExecResult,
	GlobalsInspection,
	LlmQueryFunction,
	LlmQueryRequest,
	RlmPromptMode,
	RlmSessionStats,
	RlmToolDetails,
	RuntimeSnapshot,
} from "./types.js";

const RLM_MODE_TYPE = "rlm-mode";
const PINK = "\x1b[38;5;213m";
const RESET = "\x1b[0m";

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
	const snapshot = findLatestSnapshot(ctx) ?? findBootstrapSnapshot(ctx);
	if (snapshot) await runtime.restore(snapshot);
	else await runtime.reset();
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
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				let childQueryCount = 0;
				let childTurns = 0;
				const llmQuery: LlmQueryFunction = async (input: LlmQueryRequest) => {
					childQueryCount += 1;
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
					});
					childTurns += result.usage?.turns ?? 0;
					return result;
				};

				const result = await runtime.exec(params.code, { llmQuery });

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
