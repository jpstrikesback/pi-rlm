import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { buildStaleWorkspacePromptAppendix } from "./experiment-flags.js";
import { parseRlmCommandAction } from "./rlm-command.js";
import { runChildQuery } from "./recursion.js";
import {
	buildProfileExecCodeParamDescription,
	buildProfileExecGuidelines,
	buildProfileExecPromptSnippet,
	buildProfileGuidance,
	DEFAULT_PROFILE_NAME,
	loadRlmProfileConfigFromPath,
	normalizeProfileForConfig,
	findRlmProfileFromBranch,
	resolveRlmProfileConfigPathForWrite,
	resolveRlmProfileConfigPaths,
	RLM_PROFILE_TYPE,
	resolveProfile,
	mergeProfiles,
	validateProfileSelectors,
	writeRlmProfileConfigFile,
	builtinProfiles,
	materializeProfilePromptOverrides,
} from "./profiles.js";
import {
	composeRuntimeSnapshot,
	findBootstrapSnapshot,
	findLatestSnapshot,
	findLatestWorkspace,
	getSessionRuntimeKey,
	RLM_WORKSPACE_TYPE,
} from "./restore.js";
import { RuntimeManager } from "./runtime.js";
import { collectRlmSessionStats } from "./stats.js";
import {
	applyRetentionPolicy,
	buildRetentionCompactionSummary,
	COMMITTED_RLM_RETENTION_POLICY,
	DEFAULT_RLM_RETENTION_POLICY,
	RLM_RETENTION_TYPE,
} from "./context-retention.js";
import {
	buildCompiledPromptContext,
	renderCompiledPromptContext,
	buildWorkspaceWorkingSetSummary,
	ensureWorkspaceShape,
	recordLeafToolObservation,
	recordRetentionLease,
	recordRetentionMetrics,
	recordToolEvidence,
	shouldUseCommittedRetentionPolicy,
} from "./workspace.js";
import type {
	ExecResult,
	GlobalsInspection,
	LlmQueryFunction,
	LlmQueryRequest,
	RlmChildActivity,
	RlmChildProgressEvent,
	RlmConsolidationRef,
	RlmHistoryTurn,
	RlmExecutionProfile,
	RlmRuntimeContext,
	RlmRetentionEntry,
	RlmSessionStats,
	RlmSubmodelOverride,
	RlmThinkingLevel,
	RlmToolDetails,
	RlmToolSurfaceResult,
	RlmWorkspace,
	RlmExternalizationKernelMode,
	RuntimeSnapshot,
} from "./types.js";

const RLM_MODE_TYPE = "rlm-mode";
const PINK = "\x1b[38;5;213m";
const RESET = "\x1b[0m";
const MAX_VISIBLE_CHILDREN = 8;
const LIVE_UPDATE_THROTTLE_MS = 120;
function hashFingerprint(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function extractAssistantText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block && typeof block === "object" && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block && typeof block === "object" && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function buildAssistantFingerprint(message: { role?: string; timestamp?: number; content?: unknown }): string {
	const text = extractAssistantText(message);
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
	return hashFingerprint([message.role ?? "assistant", timestamp, text.length, text.slice(0, 200)].join(":"));
}

function buildToolFingerprint(input: { toolName: string; toolCallId: string; isError: boolean }): string {
	return hashFingerprint([input.toolName, input.toolCallId, input.isError ? "error" : "ok"].join(":"));
}

function collectBranchMessages(ctx: ExtensionContext): Array<Record<string, unknown>> {
	return ctx.sessionManager
		.getBranch()
		.flatMap((entry) => {
			if (entry.type !== "message") return [];
			return [entry.message as unknown as Record<string, unknown>];
		})
		.filter((message) => {
			const role = message.role;
			return role === "user" || role === "assistant" || role === "toolResult";
		});
}

function findLatestUserQuery(ctx: ExtensionContext): string | undefined {
	const messages = collectBranchMessages(ctx);
	let latestUserMessage: string | undefined;
	for (const message of messages) {
		if (message.role === "user") latestUserMessage = extractMessageText(message.content).trim();
	}
	return latestUserMessage;
}

function buildCompiledRuntimeMessages(
	compiledContext: ReturnType<typeof buildCompiledPromptContext>,
	query?: string,
): RlmRuntimeContext["messages"] {
	const text = renderCompiledPromptContext(compiledContext, {
		title: "Deterministic compiled runtime working set from externalized state.",
		includeCurrentAsk: false,
	});
	return query
		? [
				{ role: "user", text: query },
				{ role: "assistant", text },
			]
		: [{ role: "assistant", text }];
}

function buildRuntimeContextSnapshot(
	ctx: ExtensionContext,
	workspace: RlmWorkspace | null | undefined,
	snapshot: RuntimeSnapshot | undefined,
	_externalizationKernel: RlmExternalizationKernelMode,
): {
	runtimeContext: RlmRuntimeContext;
	history: RlmHistoryTurn[];
} {
	const query = findLatestUserQuery(ctx);
	const bindings = snapshot?.bindings ?? {};
	const inputState =
		bindings.input && typeof bindings.input === "object" && !Array.isArray(bindings.input)
			? (structuredClone(bindings.input as Record<string, unknown>) as Record<string, unknown>)
			: undefined;
	const parentState =
		bindings.parentState && typeof bindings.parentState === "object" && !Array.isArray(bindings.parentState)
			? (structuredClone(bindings.parentState as Record<string, unknown>) as Record<string, unknown>)
			: undefined;
	const normalizedWorkspace =
		workspace === undefined ? undefined : workspace === null ? null : ensureWorkspaceShape(structuredClone(workspace));
	const compiledContext = buildCompiledPromptContext(normalizedWorkspace, {
		prompt: query,
		role: "worker",
		parentState,
		evidenceItemLimit: 4,
		evidenceCheckpointLimit: 3,
		artifactLimit: 4,
		exactValueLimit: 2,
	});
	return {
		runtimeContext: {
			...(query ? { query } : {}),
			...(normalizedWorkspace !== undefined ? { workspace: normalizedWorkspace } : {}),
			...(normalizedWorkspace?.activeContext
				? { activeContext: structuredClone(normalizedWorkspace.activeContext) }
				: {}),
			...(normalizedWorkspace?.childArtifactSummaries
				? { artifactSummaries: structuredClone(normalizedWorkspace.childArtifactSummaries) }
				: {}),
			...(normalizedWorkspace?.retention ? { retention: structuredClone(normalizedWorkspace.retention) } : {}),
			...(parentState ? { parentState } : {}),
			...(inputState ? { input: inputState } : {}),
			compiledContext,
			messages: buildCompiledRuntimeMessages(compiledContext, query),
		},
		history: [],
	};
}

function buildSurfaceText(surface: RlmToolSurfaceResult): string {
	if (!surface.refs || surface.refs.length === 0) return surface.text;
	const refs = surface.refs.map((ref) => ref.ref).join(", ");
	return `${surface.text}\nRefs: ${refs}`;
}

function buildExecSurfaceResult(result: ExecResult): RlmToolSurfaceResult {
	if (!result.ok) return { text: "Execution failed." };
	if (result.snapshot.bindings.workspace) {
		const refs: RlmConsolidationRef[] = [{ kind: "workspace-path", ref: "globalThis.workspace" }];
		const state = result.workspaceState;
		if (state?.pendingConsolidation) {
			return {
				text: "Execution succeeded. Workspace still has unconsolidated state.",
				refs,
			};
		}
		if ((result.commitCount ?? 0) > 0) {
			return { text: "Execution succeeded. Workspace consolidated.", refs };
		}
		return { text: "Execution succeeded. Workspace updated.", refs };
	}
	return { text: "Execution succeeded." };
}

function buildInspectionSurfaceResult(inspection: GlobalsInspection): RlmToolSurfaceResult {
	return {
		text: `RLM runtime inspection complete. ${inspection.entries.length} binding${inspection.entries.length === 1 ? "" : "s"} available.`,
		refs: [{ kind: "workspace-path", ref: "globalThis.workspace" }],
	};
}

function getRetentionPolicyForWorkspace(workspace: RlmWorkspace | null | undefined) {
	return shouldUseCommittedRetentionPolicy(workspace) ? COMMITTED_RLM_RETENTION_POLICY : DEFAULT_RLM_RETENTION_POLICY;
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

function applyProfileWidget(ctx: ExtensionContext, enabled: boolean, profile: string, root: boolean) {
	if (!root || !ctx.hasUI) return;
	ctx.ui.setWidget("rlm-profile", enabled ? [`${PINK}RLM PROFILE${RESET} ${profile}`] : undefined, {
		placement: "aboveEditor",
	});
}

function applyStatus(ctx: ExtensionContext, enabled: boolean, profile: string, root: boolean, stats?: RlmSessionStats) {
	if (!root || !ctx.hasUI) return;
	if (!enabled) {
		ctx.ui.setStatus("rlm-stats", undefined);
		return;
	}
	const nextStats = stats ?? collectRlmSessionStats(ctx, { depth: 0, maxDepth: 0 });
	const theme = ctx.ui.theme;
	const header = theme.fg("accent", `RLM ${profile}`);
	const details = theme.fg(
		"dim",
		` · d ${nextStats.depth}/${nextStats.maxDepth} · exec ${nextStats.execCount} · child ${nextStats.childTurns > 0 ? `${nextStats.childQueryCount}/${nextStats.childTurns}t` : `${nextStats.childQueryCount}`} · vars ${nextStats.runtimeVarCount} · act ${nextStats.activeContextRefCount} · leaf ${nextStats.leafToolCount}`,
	);
	ctx.ui.setStatus("rlm-stats", header + details);
}

async function restoreRuntime(manager: RuntimeManager, initializedKeys: Set<string>, ctx: ExtensionContext) {
	const key = getSessionRuntimeKey(ctx);
	const runtime = manager.getOrCreate(key);
	const workspace = normalizeWorkspaceBinding(findLatestWorkspace(ctx));
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

function normalizeWorkspaceBinding(value: unknown): RlmWorkspace | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return ensureWorkspaceShape(structuredClone(value));
}

function markRunningChildrenInterrupted(workspace: RlmWorkspace): RlmWorkspace {
	const next = ensureWorkspaceShape(structuredClone(workspace));
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
	currentWorkspace: RlmWorkspace | undefined,
	previousWorkspace: RlmWorkspace | null | undefined,
) {
	const nextWorkspace = currentWorkspace ?? null;
	const lastWorkspace = previousWorkspace ?? null;
	if (isDeepStrictEqual(nextWorkspace, lastWorkspace)) return;
	pi.appendEntry(RLM_WORKSPACE_TYPE, { workspace: nextWorkspace });
}

function renderRlmExecResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: any,
) {
	const details = result.details as RlmToolDetails | undefined;
	const visibleChildren = details?.live?.children ?? [];
	const childSummary = details?.childQueryCount
		? ` · child ${details.childQueryCount}${details.childTurns ? `/${details.childTurns}t` : ""}`
		: "";

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
	profile?: string;
	profiles?: Record<string, RlmExecutionProfile>;
	profileConfigPath?: string;
	externalizationKernel?: RlmExternalizationKernelMode;
}): ExtensionFactory {
	return function installRlm(pi: ExtensionAPI) {
		const manager = new RuntimeManager();
		const initializedKeys = new Set<string>();
		let rlmModeEnabled = !options.root;
		let activeProfileName = options.profile ?? DEFAULT_PROFILE_NAME;
		let configuredProfiles = mergeProfiles(options.profiles);
		const builtinProfileRegistry = builtinProfiles();
		let resolvedProfile = resolveProfile(activeProfileName, configuredProfiles);
		let validatedProfileName: string | undefined;
		let activeTurnIndex = 0;
		let pendingRetentionEntry: RlmRetentionEntry | undefined;
		let emittedRetentionTurnIndex = -1;
		let pendingWorkspace: RlmWorkspace | undefined;

		const persistMode = (enabled: boolean) => {
			rlmModeEnabled = enabled;
			pi.appendEntry(RLM_MODE_TYPE, { enabled });
		};

		const getContextCwd = (ctx: ExtensionContext): string => {
			const rawCwd = (ctx as { cwd?: string }).cwd;
			return typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : process.cwd();
		};

		const getProfileConfigEntries = (ctx: ExtensionContext) => {
			return resolveRlmProfileConfigPaths(getContextCwd(ctx), options.profileConfigPath).map((path) => ({
				path,
				profiles: loadRlmProfileConfigFromPath(path),
			}));
		};

		const reloadConfiguredProfiles = (ctx: ExtensionContext) => {
			const fileProfiles: Record<string, RlmExecutionProfile> = Object.create(null);
			for (const entry of getProfileConfigEntries(ctx)) {
				Object.assign(fileProfiles, entry.profiles);
			}
			configuredProfiles = mergeProfiles({ ...fileProfiles, ...(options.profiles ?? {}) });
		};

		const getEffectiveProfileSource = (name: string, ctx: ExtensionContext): string => {
			const entries = getProfileConfigEntries(ctx).slice().reverse();
			for (const entry of entries) {
				if (Object.prototype.hasOwnProperty.call(entry.profiles, name)) return entry.path;
			}
			if (options.profiles && Object.prototype.hasOwnProperty.call(options.profiles, name)) return "options";
			if (Object.prototype.hasOwnProperty.call(builtinProfileRegistry, name)) return "builtin";
			return "builtin";
		};

		const profileArgumentCompletions = (argumentPrefix: string) => {
			const trim = argumentPrefix.trimStart();
			const lower = trim.toLowerCase();

			const allProfiles = Object.keys(configuredProfiles).sort();
			const profileNames = allProfiles.map((name) => ({ value: name, label: `${name}` }));
			const baseCompletions = [
				{ value: "profile list", label: "profile list" },
				{ value: "profile add ", label: "profile add <name> <json>" },
				{ value: "profile clone ", label: "profile clone <from> <to>" },
				{ value: "profile set ", label: "profile set <name>" },
				{ value: "profile remove ", label: "profile remove <name>" },
				{ value: "profile inspect ", label: "profile inspect [name]" },
				{ value: "inspect", label: "inspect runtime" },
				{ value: "reset", label: "reset runtime" },
			];

			if (!lower) return baseCompletions;

			if (!lower.startsWith("profile")) {
				return baseCompletions
					.filter((candidate) => candidate.value.toLowerCase().startsWith(lower))
					.map((candidate) => ({ ...candidate, value: `${candidate.value}` }));
			}

			const afterProfile = trim.slice("profile".length).trimStart();
			if (!afterProfile) {
				return baseCompletions.filter((candidate) => candidate.value.startsWith("profile"));
			}

			const afterProfileLower = afterProfile.toLowerCase();
			if (afterProfileLower.startsWith("clone")) {
				const cloneArgs = afterProfile.slice(5).trimStart().split(/\s+/).filter(Boolean);
				if (cloneArgs.length <= 1) {
					const sourcePrefix = cloneArgs[0]?.toLowerCase() ?? "";
					return profileNames
						.filter((item) => item.value.startsWith(sourcePrefix))
						.map((item) => ({ value: `profile clone ${item.value} `, label: `clone from ${item.value}` }));
				}
				return [];
			}

			if (afterProfileLower.startsWith("set")) {
				const profilePrefix = afterProfile.slice(3).trimStart().toLowerCase();
				return profileNames
					.filter((item) => item.value.startsWith(profilePrefix))
					.map((item) => ({ value: `profile set ${item.value}`, label: item.value }));
			}

			if (afterProfileLower.startsWith("remove")) {
				const profilePrefix = afterProfile.slice(6).trimStart().toLowerCase();
				return profileNames
					.filter((item) => item.value.startsWith(profilePrefix))
					.map((item) => ({ value: `profile remove ${item.value}`, label: item.value }));
			}

			if (afterProfileLower.startsWith("inspect")) {
				const profilePrefix = afterProfile.slice(7).trimStart().toLowerCase();
				return profileNames
					.filter((item) => item.value.startsWith(profilePrefix))
					.map((item) => ({ value: `profile inspect ${item.value}`, label: item.value }));
			}

			return baseCompletions
				.filter((candidate) => candidate.value.toLowerCase().startsWith(lower))
				.map((candidate) => ({ ...candidate, value: `${candidate.value}` }));
		};

		const resolveActiveProfile = async (profile: string | undefined, ctx: ExtensionContext) => {
			reloadConfiguredProfiles(ctx);
			const nextProfile = resolveProfile(profile, configuredProfiles);
			await validateProfileSelectors(nextProfile, ctx.modelRegistry);
			resolvedProfile = nextProfile;
			activeProfileName = resolvedProfile.name;
			validatedProfileName = activeProfileName;
			return resolvedProfile;
		};
		const persistProfile = async (profile: string, ctx: ExtensionContext) => {
			await resolveActiveProfile(profile, ctx);
			pi.appendEntry(RLM_PROFILE_TYPE, { profile: activeProfileName });
		};
		const setProfile = async (profile: string, ctx: ExtensionContext) => {
			try {
				await persistProfile(profile, ctx);
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				const stats = computeStats(ctx, options, runtime.getSnapshot());
				applyProfileWidget(ctx, rlmModeEnabled, activeProfileName, true);
				applyStatus(ctx, rlmModeEnabled, activeProfileName, true, stats);
				ctx.ui.notify(`RLM profile: ${activeProfileName}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not switch to RLM profile "${profile}": ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		};
		const listProfiles = (ctx: ExtensionContext) => {
			reloadConfiguredProfiles(ctx);
			return Object.keys(configuredProfiles).sort().map((name) => ({
				name,
				active: name === activeProfileName,
			}));
		};
		const inspectProfile = (name: string | undefined, ctx: ExtensionContext) => {
			reloadConfiguredProfiles(ctx);
			const target = name?.trim();
			const profileName = target && target.length > 0 ? target : activeProfileName;
			if (!profileName) throw new Error("No active profile.");
			const resolved = resolveProfile(profileName, configuredProfiles);
			return {
				name: resolved.name,
				active: profileName === activeProfileName,
				source: getEffectiveProfileSource(resolved.name, ctx),
				profile: resolved,
			};
		};
		const openProfileMenu = async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"Use /rlm profile list, /rlm profile set <name>, /rlm profile inspect [name], /rlm profile add/remove <name> ... in non-interactive mode.",
					"info",
				);
				return;
			}
			const entries = listProfiles(ctx);
			if (entries.length === 0) {
				ctx.ui.notify("No RLM profiles are currently configured.", "warning");
				return;
			}
			const profileMenu = [
				"Inspect active profile",
				...entries.map((entry) => (entry.active ? `Switch active profile: ${entry.name}` : `Switch to profile: ${entry.name}`)),
				...entries.map((entry) => `Inspect profile: ${entry.name}`),
			];
			const selected = await ctx.ui.select("RLM profile", profileMenu);
			if (!selected) return;
			if (selected === "Inspect active profile") {
				const details = inspectProfile(activeProfileName, ctx);
				await ctx.ui.editor(`RLM profile: ${details.name}`, JSON.stringify(details, null, 2));
				return;
			}
			if (selected.startsWith("Switch")) {
				const profile = selected.replace(/^Switch(?: active| to)? profile: /, "").trim();
				await setProfile(profile, ctx);
				return;
			}
			if (selected.startsWith("Inspect profile: ")) {
				const profile = selected.replace("Inspect profile: ", "").trim();
				const details = inspectProfile(profile, ctx);
				await ctx.ui.editor(`RLM profile: ${details.name}`, JSON.stringify(details, null, 2));
				return;
			}
			ctx.ui.notify(`Unknown profile menu action: ${selected}`, "error");
		};
		const addProfile = async (name: string, value: string, ctx: ExtensionContext) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch (error) {
				throw new Error(`Could not parse profile JSON for "${name}": ${error instanceof Error ? error.message : String(error)}`);
			}
			const profile = normalizeProfileForConfig(name, parsed);
			const writePath = resolveRlmProfileConfigPathForWrite(getContextCwd(ctx), options.profileConfigPath);
			const existing = loadRlmProfileConfigFromPath(writePath);
			existing[name] = profile;
			writeRlmProfileConfigFile(writePath, existing);
			reloadConfiguredProfiles(ctx);
			await resolveActiveProfile(name, ctx);
			return { writePath };
		};
		const cloneProfile = async (sourceName: string, targetName: string, ctx: ExtensionContext) => {
			reloadConfiguredProfiles(ctx);
			if (!Object.prototype.hasOwnProperty.call(configuredProfiles, sourceName)) {
				throw new Error(`Unknown source profile: ${sourceName}`);
			}
			const sourceProfile = resolveProfile(sourceName, configuredProfiles);
			const writePath = resolveRlmProfileConfigPathForWrite(getContextCwd(ctx), options.profileConfigPath);
			const existing = loadRlmProfileConfigFromPath(writePath);
			existing[targetName] = normalizeProfileForConfig(targetName, {
				...sourceProfile,
				name: targetName,
				promptOverrides: materializeProfilePromptOverrides(sourceProfile),
			});
			writeRlmProfileConfigFile(writePath, existing);
			reloadConfiguredProfiles(ctx);
			await resolveActiveProfile(targetName, ctx);
			return { writePath };
		};
		const removeProfile = async (name: string, ctx: ExtensionContext) => {
			const entries = getProfileConfigEntries(ctx).slice().reverse();
			for (const entry of entries) {
				if (!entry.profiles[name]) continue;
				const nextProfiles = { ...entry.profiles };
				delete nextProfiles[name];
				writeRlmProfileConfigFile(entry.path, nextProfiles);
				reloadConfiguredProfiles(ctx);
				return { removed: true, path: entry.path };
			}
			return { removed: false };
		};

		pi.registerFlag("rlm-enabled", {
			description: "Enable root RLM mode automatically on session start",
			type: "boolean",
			default: false,
		});
		pi.registerFlag("rlm-profile", {
			description: "Active RLM execution profile",
			type: "string",
			default: DEFAULT_PROFILE_NAME,
		});
		pi.registerFlag("rlm-externalization-kernel", {
			description: "Externalization-kernel mode for Milestone I experiment: current | no-subcalls",
			type: "string",
			default: "current",
		});

		const isRlmActive = () => !options.root || rlmModeEnabled;
		const getExternalizationKernel = (): RlmExternalizationKernelMode => {
			const raw = options.externalizationKernel ?? pi.getFlag("rlm-externalization-kernel");
			return raw === "no-subcalls" ? "no-subcalls" : "current";
		};

		const captureRetention = (
			messages: Parameters<typeof applyRetentionPolicy>[0],
			ctx: ExtensionContext,
		): ReturnType<typeof applyRetentionPolicy> | undefined => {
			if (!isRlmActive()) {
				pendingRetentionEntry = undefined;
				return undefined;
			}
			const workspace = normalizeWorkspaceBinding(pendingWorkspace ?? findLatestWorkspace(ctx));
			const workspaceSummary = buildWorkspaceWorkingSetSummary(workspace);
			const policy = getRetentionPolicyForWorkspace(workspace);
			const result = applyRetentionPolicy(messages, {
				workspace,
				policy,
				currentTurnIndex: activeTurnIndex,
				externalizationKernel: getExternalizationKernel(),
			});
			pendingRetentionEntry = {
				version: 1,
				turnIndex: activeTurnIndex,
				policy,
				metrics: result.metrics,
				...(workspaceSummary ? { workspaceSummary } : {}),
			};
			return result;
		};

		const emitRetentionEntry = (turnIndex: number): RlmRetentionEntry | undefined => {
			if (
				!pendingRetentionEntry ||
				pendingRetentionEntry.turnIndex !== turnIndex ||
				emittedRetentionTurnIndex === turnIndex
			)
				return undefined;
			const entry = pendingRetentionEntry;
			pi.appendEntry(RLM_RETENTION_TYPE, entry);
			emittedRetentionTurnIndex = turnIndex;
			pendingRetentionEntry = undefined;
			return entry;
		};

		const getWorkspaceBase = (ctx: ExtensionContext) =>
			normalizeWorkspaceBinding(pendingWorkspace ?? findLatestWorkspace(ctx));

		const queueWorkspaceUpdate = (next: RlmWorkspace | undefined) => {
			if (!next) return;
			pendingWorkspace = normalizeWorkspaceBinding(next) ?? next;
		};

		const flushWorkspaceUpdates = (ctx: ExtensionContext) => {
			if (!pendingWorkspace) return;
			const previousWorkspace = normalizeWorkspaceBinding(findLatestWorkspace(ctx));
			persistWorkspaceEntry(pi, pendingWorkspace, previousWorkspace);
			pendingWorkspace = undefined;
		};

		const syncRetentionWorkspace = (ctx: ExtensionContext, retention: RlmRetentionEntry | undefined) => {
			if (!retention) return;
			const base = getWorkspaceBase(ctx);
			if (!base) return;
			const nextWorkspace = recordRetentionMetrics(base, retention.metrics, retention.turnIndex, retention.policy);
			queueWorkspaceUpdate(nextWorkspace);
		};

		const recordLease = (
			ctx: ExtensionContext,
			input: {
				source: "assistant" | "tool";
				sourceName?: string;
				turnIndex: number;
				messageFingerprint: string;
				expiresAfterTurns?: number;
			},
		) => {
			const base = getWorkspaceBase(ctx);
			if (!base) return;
			const nextWorkspace = recordRetentionLease(base, input);
			queueWorkspaceUpdate(nextWorkspace);
		};

		const refreshState = async (ctx: ExtensionContext) => {
			const runtime = await restoreRuntime(manager, initializedKeys, ctx);
			if (options.root) {
				const flagEnabled = pi.getFlag("rlm-enabled") === true;
				const persistedEnabled = findRlmModeEnabled(ctx);
				reloadConfiguredProfiles(ctx);
				if (flagEnabled && !persistedEnabled) {
					persistMode(true);
				}
				rlmModeEnabled = flagEnabled || persistedEnabled;
				const profileFlag = pi.getFlag("rlm-profile");
				const requestedProfile =
					findRlmProfileFromBranch(ctx) ?? (typeof profileFlag === "string" ? profileFlag.trim() : undefined);
				if (requestedProfile) {
					try {
						await resolveActiveProfile(requestedProfile, ctx);
						registerExecTool();
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						const fallbackCandidates = Array.from(new Set([DEFAULT_PROFILE_NAME, "inherit-parent-class"])).filter(
							(profileName) => profileName !== requestedProfile,
						);
						if (ctx.ui?.notify) {
							const fallbackText =
								fallbackCandidates.length > 0
									? ` Trying fallback profile${fallbackCandidates.length > 1 ? "s" : ""}: ${fallbackCandidates.join(", ")}.`
									: " No alternate fallback profiles are configured.";
							ctx.ui.notify(`Could not activate RLM profile "${requestedProfile}": ${reason}.${fallbackText}`, "error");
						}
						let fallbackActivated = false;
						for (const fallback of fallbackCandidates) {
							try {
								await resolveActiveProfile(fallback, ctx);
								registerExecTool();
								fallbackActivated = true;
								break;
							} catch {
								// Try the next fallback candidate.
							}
						}
						if (!fallbackActivated) {
							const finalFallback = fallbackCandidates[0] ?? requestedProfile;
							resolvedProfile = resolveProfile(finalFallback, configuredProfiles);
							activeProfileName = resolvedProfile.name;
							validatedProfileName = undefined;
						}
					}
				} else if (validatedProfileName !== activeProfileName) {
					try {
						await resolveActiveProfile(activeProfileName, ctx);
						registerExecTool();
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						if (ctx.ui?.notify) {
							ctx.ui.notify(`Could not validate default RLM profile "${activeProfileName}": ${reason}.`, "error");
						}
						resolvedProfile = resolveProfile(DEFAULT_PROFILE_NAME, configuredProfiles);
						activeProfileName = resolvedProfile.name;
						validatedProfileName = activeProfileName;
						registerExecTool();
					}
				}
			}
			const stats = computeStats(ctx, options, runtime.getSnapshot());
			applyProfileWidget(ctx, rlmModeEnabled, activeProfileName, options.root);
			applyStatus(ctx, rlmModeEnabled, activeProfileName, options.root, stats);
		};

		const restoreHandler = async (_event: unknown, ctx: ExtensionContext) => {
			await refreshState(ctx);
		};

		pi.on("session_start", restoreHandler);
		pi.on("session_before_switch", restoreHandler);
		pi.on("session_tree", restoreHandler);
		pi.on("session_before_fork", restoreHandler);
		pi.on("session_before_compact", async (event, ctx) => {
			if (!isRlmActive()) return;
			const workspace = getWorkspaceBase(ctx);
			return {
				compaction: {
					summary: buildRetentionCompactionSummary(workspace, event.preparation),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {
						workspaceSummary: buildWorkspaceWorkingSetSummary(workspace),
						activeContextRefCount: workspace?.activeContext?.currentArtifactRefs?.length ?? 0,
						summarizedMessages: event.preparation.messagesToSummarize.length,
						keptTurnPrefixMessages: event.preparation.turnPrefixMessages.length,
					},
				},
			};
		});
		pi.on("session_compact", async (_event, ctx) => {
			syncRetentionWorkspace(ctx, pendingRetentionEntry);
			flushWorkspaceUpdates(ctx);
			const runtime = await getRuntime(manager, initializedKeys, ctx);
			const stats = computeStats(ctx, options, runtime.getSnapshot());
			applyStatus(ctx, rlmModeEnabled, activeProfileName, options.root, stats);
		});
		pi.on("session_shutdown", async () => {
			await manager.disposeAll();
		});
		pi.on("turn_start", async (event) => {
			activeTurnIndex = event.turnIndex;
		});
		pi.on("context", async (event, ctx) => {
			const result = captureRetention(event.messages, ctx);
			if (!result) return { messages: event.messages };
			return { messages: result.messages };
		});
		pi.on("tool_execution_end", async (event, ctx) => {
			if (!isRlmActive()) return;
			const now = new Date().toISOString();
			if (event.toolName !== "rlm_exec" && event.toolName !== "rlm_inspect" && event.toolName !== "rlm_reset") {
				const base = getWorkspaceBase(ctx);
				const observedWorkspace = recordLeafToolObservation(base, { turnIndex: activeTurnIndex, now });
				const evidenceWorkspace = recordToolEvidence(observedWorkspace, {
					turnIndex: activeTurnIndex,
					toolName: event.toolName,
					args: (event as { args?: unknown }).args,
					result: (event as { result?: unknown }).result,
					isError: event.isError,
					now,
				});
				queueWorkspaceUpdate(evidenceWorkspace);
			}
			const retentionPolicy = getRetentionPolicyForWorkspace(getWorkspaceBase(ctx));
			recordLease(ctx, {
				source: "tool",
				sourceName: event.toolName,
				turnIndex: activeTurnIndex,
				messageFingerprint: buildToolFingerprint({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					isError: event.isError,
				}),
				expiresAfterTurns: retentionPolicy.expireConsolidatedAfterTurns,
			});
		});
		pi.on("message_end", async (event, ctx) => {
			if (!isRlmActive()) return;
			if (event.message.role !== "assistant") return;
			const retentionPolicy = getRetentionPolicyForWorkspace(getWorkspaceBase(ctx));
			recordLease(ctx, {
				source: "assistant",
				sourceName: "assistant",
				turnIndex: activeTurnIndex,
				messageFingerprint: buildAssistantFingerprint(event.message),
				expiresAfterTurns: retentionPolicy.expireConsolidatedAfterTurns,
			});
		});
		pi.on("turn_end", async (event, ctx) => {
			const retentionEntry = emitRetentionEntry(event.turnIndex);
			syncRetentionWorkspace(ctx, retentionEntry);
			flushWorkspaceUpdates(ctx);
			const runtime = await getRuntime(manager, initializedKeys, ctx);
			const stats = computeStats(ctx, options, runtime.getSnapshot());
			applyStatus(ctx, rlmModeEnabled, activeProfileName, options.root, stats);
		});

		pi.on("before_agent_start", async (event, ctx) => {
			const runtime = await getRuntime(manager, initializedKeys, ctx);
			const stats = computeStats(ctx, options, runtime.getSnapshot());
			applyStatus(ctx, rlmModeEnabled, activeProfileName, options.root, stats);
			if (!isRlmActive()) return;
			const workspace = getWorkspaceBase(ctx);
			const profileAppendix = buildProfileGuidance(resolvedProfile, {
				externalizationKernel: getExternalizationKernel(),
				root: options.root,
			});
			const staleWorkspaceNote = buildStaleWorkspacePromptAppendix(workspace).trim();
			return {
				systemPrompt: [
					event.systemPrompt,
					profileAppendix ? `RLM execution profile appendix:\n${profileAppendix}` : "",
					staleWorkspaceNote,
				]
					.filter((section) => section.length > 0)
					.join("\n\n"),
			};
		});

		const getExecMode = () => getExternalizationKernel();
		const getExecGuidelines = () =>
			buildProfileExecGuidelines(resolvedProfile, { externalizationKernel: getExecMode(), root: options.root });
		const getExecDescription = (externalizationKernel: RlmExternalizationKernelMode) =>
			externalizationKernel === "no-subcalls"
				? "Persistent JS runtime for deterministic compiled context, durable workspace state, and leaf-tool execution without child-query helpers."
				: "Persistent JS runtime for deterministic compiled context, durable workspace commits, and child RLM queries.";
		const getExecPromptSnippet = (externalizationKernel: RlmExternalizationKernelMode) =>
			buildProfileExecPromptSnippet(resolvedProfile, { externalizationKernel });
		const getExecCodeParamDescription = (externalizationKernel: RlmExternalizationKernelMode) =>
			buildProfileExecCodeParamDescription(resolvedProfile, { externalizationKernel });
		const registerExecTool = () => {
			const currentExecMode = getExecMode();

			pi.registerTool({
			name: "rlm_exec",
			label: "RLM Exec",
			description: getExecDescription(currentExecMode),
			promptSnippet: getExecPromptSnippet(currentExecMode),
			promptGuidelines: getExecGuidelines(),
			parameters: Type.Object({
				code: Type.String({
					description: getExecCodeParamDescription(currentExecMode),
				}),
			}),
			renderCall(_args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("rlm_exec")), 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				return renderRlmExecResult(
					result as { content: Array<{ type: string; text?: string }>; details?: unknown },
					{ expanded, isPartial },
					theme,
				);
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				const previousWorkspace = getWorkspaceBase(ctx);
				if (previousWorkspace !== undefined) {
					await runtime.restore(composeRuntimeSnapshot(runtime.getSnapshot(), previousWorkspace));
				}
				const externalizationKernel = getExternalizationKernel();
				const { runtimeContext, history } = buildRuntimeContextSnapshot(
					ctx,
					previousWorkspace,
					runtime.getSnapshot(),
					externalizationKernel,
				);
				let childQueryCount = 0;
				let childTurns = 0;
				let lastUpdateAt = 0;
				let liveUpdatesEnabled = true;
				const submodelOverrides: RlmSubmodelOverride[] = [];
				const children = new Map<string, RlmChildActivity>();
				const emitLiveUpdate = () => {
					if (!liveUpdatesEnabled) return;
					const now = Date.now();
					if (now - lastUpdateAt < LIVE_UPDATE_THROTTLE_MS) return;
					lastUpdateAt = now;
					try {
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
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (/outside active run/i.test(message)) {
							liveUpdatesEnabled = false;
							return;
						}
						throw error;
					}
				};
				const allowChildQueries = externalizationKernel !== "no-subcalls";
				const llmQuery: LlmQueryFunction | undefined = allowChildQueries
					? async (input: LlmQueryRequest) => {
							childQueryCount += 1;
							emitLiveUpdate();
							const result = await runChildQuery(input, ctx, {
								depth: options.depth + 1,
								maxDepth: options.maxDepth,
								extensionFactory: createRlmExtensionFactory({
									depth: options.depth + 1,
									maxDepth: options.maxDepth,
									root: false,
									profile: resolvedProfile.name,
									profiles: options.profiles,
									externalizationKernel,
								}),
								parentActiveTools: pi.getActiveTools(),
								parentThinkingLevel: pi.getThinkingLevel() as RlmThinkingLevel,
								defaultSimpleModel: resolvedProfile.helpers.simpleChild.defaultModel,
								defaultRecursiveModel: resolvedProfile.helpers.recursiveChild.defaultModel,
								recursiveChildInheritParentByDefault: resolvedProfile.helpers.recursiveChild.inheritParentByDefault,
								onMissingSimpleChildModel: resolvedProfile.fallback.onMissingSimpleChildModel,
								onMissingRecursiveChildModel: resolvedProfile.fallback.onMissingRecursiveChildModel,
								simpleChildDisabled: !!resolvedProfile.helpers.simpleChild.disabled,
								recursiveChildDisabled: !!resolvedProfile.helpers.recursiveChild.disabled,
								onResolvedModel: (override) => {
									submodelOverrides.push(override);
								},
								onProgress: (event) => {
									applyChildProgress(children, event);
									emitLiveUpdate();
								},
							});
							childTurns += result.usage?.turns ?? 0;
							emitLiveUpdate();
							return result;
						}
					: undefined;

				emitLiveUpdate();
				const result = await runtime.exec(params.code, {
					llmQuery,
					turnIndex: activeTurnIndex,
					runtimeContext,
					history,
					externalizationKernel,
				});
				const nextWorkspace = normalizeWorkspaceBinding(result.snapshot.bindings.workspace);
				persistWorkspaceEntry(pi, nextWorkspace, previousWorkspace);

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
					commitCount: result.commitCount,
					commitResults: result.commitResults,
					workspaceState: result.workspaceState,
					attemptedSimpleQueryCount: result.attemptedSimpleQueryCount,
					attemptedSimpleBatchCount: result.attemptedSimpleBatchCount,
					attemptedRecursiveQueryCount: result.attemptedRecursiveQueryCount,
					attemptedRecursiveBatchCount: result.attemptedRecursiveBatchCount,
					simpleQueryCount: result.simpleQueryCount,
					simpleBatchCount: result.simpleBatchCount,
					recursiveQueryCount: result.recursiveQueryCount,
					recursiveBatchCount: result.recursiveBatchCount,
					submodelOverrideCount: result.submodelOverrideCount,
					showVarsCount: result.showVarsCount,
					finalAliasUsed: result.finalAliasUsed,
					finalVarAliasUsed: result.finalVarAliasUsed,
					contextMessageCount: result.contextMessageCount,
					historyCount: result.historyCount,
					runtimeBindingCountBefore: result.runtimeBindingCountBefore,
					runtimeBindingCountAfter: result.runtimeBindingCountAfter,
					runtimeNewBindingCount: result.runtimeNewBindingCount,
					runtimeUpdatedBindingCount: result.runtimeUpdatedBindingCount,
					submodelOverrides,
					live: {
						children: getVisibleChildren(children),
					},
				};

				const stats = computeStats(ctx, options, result.snapshot);
				stats.childQueryCount += childQueryCount;
				stats.childTurns += childTurns;
				stats.execCount += 1;
				applyStatus(ctx, rlmModeEnabled, activeProfileName, options.root, stats);

				const surface = buildExecSurfaceResult(result);
				return {
					content: [{ type: "text", text: buildSurfaceText(surface) }],
					details: { ...details, surface },
				};
			},
			});
		};
		registerExecTool();

		pi.registerTool({
			name: "rlm_inspect",
			label: "RLM Inspect",
			description: "Inspect the current persistent runtime variables.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const runtime = await getRuntime(manager, initializedKeys, ctx);
				const inspection = await runtime.inspect();
				const stats = computeStats(ctx, options, runtime.getSnapshot());
				applyStatus(ctx, rlmModeEnabled, activeProfileName, options.root, stats);
				const surface = buildInspectionSurfaceResult(inspection);
				return {
					content: [{ type: "text", text: buildSurfaceText(surface) }],
					details: {
						snapshot: runtime.getSnapshot(),
						inspection,
						surface,
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
				applyStatus(ctx, rlmModeEnabled, activeProfileName, options.root, stats);
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
			const setProfile = async (profile: string, ctx: ExtensionCommandContext) => {
				try {
					await persistProfile(profile, ctx);
					const runtime = await getRuntime(manager, initializedKeys, ctx);
					const stats = computeStats(ctx, options, runtime.getSnapshot());
					applyProfileWidget(ctx, rlmModeEnabled, activeProfileName, true);
					applyStatus(ctx, rlmModeEnabled, activeProfileName, true, stats);
					ctx.ui.notify(`RLM profile: ${activeProfileName}`, "info");
				} catch (error) {
					ctx.ui.notify(
						`Could not switch to RLM profile "${profile}": ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			};

			pi.registerCommand("rlm", {
				description: "Toggle RLM mode, list/inspect/manage profiles, inspect runtime, or reset",
				getArgumentCompletions: (argumentPrefix) => {
					const completions = profileArgumentCompletions(argumentPrefix).filter((entry) =>
						entry.value.toLowerCase().startsWith(argumentPrefix.trim().toLowerCase()),
					);
					return completions.length > 0 ? completions : null;
				},
				handler: async (args, ctx: ExtensionCommandContext) => {
					const action = parseRlmCommandAction(args);
					switch (action.type) {
						case "toggle": {
							persistMode(!rlmModeEnabled);
							const runtime = await getRuntime(manager, initializedKeys, ctx);
							const stats = computeStats(ctx, options, runtime.getSnapshot());
							applyProfileWidget(ctx, rlmModeEnabled, activeProfileName, true);
							applyStatus(ctx, rlmModeEnabled, activeProfileName, true, stats);
							ctx.ui.notify(`RLM mode ${rlmModeEnabled ? "enabled" : "disabled"}`, "info");
							return;
						}
						case "set-profile":
							await setProfile(action.profile, ctx);
							return;
						case "list-profiles": {
							const profiles = listProfiles(ctx);
							if (profiles.length === 0) {
								ctx.ui.notify("No RLM profiles are currently configured.", "warning");
								return;
							}
							const lines = profiles.map((entry) => `${entry.active ? "*" : " "} ${entry.name}`);
							ctx.ui.notify(`RLM profiles:\n${lines.join("\n")}`, "info");
							return;
						}
						case "inspect-profile": {
							const details = inspectProfile(action.profile, ctx);
							const payload = JSON.stringify(details, null, 2);
							if (ctx.hasUI) {
								await ctx.ui.editor(`RLM profile: ${details.name}`, payload);
							} else {
								ctx.ui.notify(payload, "info");
							}
							return;
						}
						case "profile-menu":
							await openProfileMenu(ctx);
							return;
						case "add-profile":
							try {
								const { writePath } = await addProfile(action.profile, action.value, ctx);
								await setProfile(action.profile, ctx);
								ctx.ui.notify(`Saved RLM profile "${action.profile}" to ${writePath}.`, "info");
							} catch (error) {
								ctx.ui.notify(
									`Could not add RLM profile "${action.profile}": ${error instanceof Error ? error.message : String(error)}`,
									"error",
								);
							}
							return;
						case "clone-profile":
							try {
								const { writePath } = await cloneProfile(action.sourceProfile, action.profile, ctx);
								await setProfile(action.profile, ctx);
								ctx.ui.notify(`Cloned RLM profile "${action.sourceProfile}" to "${action.profile}" in ${writePath}.`, "info");
							} catch (error) {
								ctx.ui.notify(
									`Could not clone RLM profile "${action.sourceProfile}" to "${action.profile}": ${error instanceof Error ? error.message : String(error)}`,
									"error",
								);
							}
							return;
						case "remove-profile": {
							const removed = await removeProfile(action.profile, ctx);
							if (!removed.removed) {
								ctx.ui.notify(
									`RLM profile "${action.profile}" not found in user config.`, 
									"error",
								);
								return;
							}
							if (activeProfileName === action.profile) {
								await persistProfile(action.profile, ctx);
								const runtime = await getRuntime(manager, initializedKeys, ctx);
								const stats = computeStats(ctx, options, runtime.getSnapshot());
								applyProfileWidget(ctx, rlmModeEnabled, activeProfileName, true);
								applyStatus(ctx, rlmModeEnabled, activeProfileName, true, stats);
							}
							ctx.ui.notify(`Removed RLM profile "${action.profile}" from ${removed.path}. Active source is now ${inspectProfile(activeProfileName, ctx).source}.`, "info");
							return;
						}
						case "inspect": {
							const runtime = await getRuntime(manager, initializedKeys, ctx);
							const inspection = await runtime.inspect();
							const stats = computeStats(ctx, options, runtime.getSnapshot());
							applyStatus(ctx, rlmModeEnabled, activeProfileName, true, stats);
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
							applyStatus(ctx, rlmModeEnabled, activeProfileName, true, stats);
							ctx.ui.notify("RLM runtime reset", "info");
							return;
						}
						case "invalid":
							ctx.ui.notify(
								"Usage: /rlm [profile|profile <name>|profile list|profile add <name> <json>|profile clone <from> <to>|profile remove <name>|profile inspect [name]|inspect|toggle|reset]",
								"error",
							);
							return;
					}
				},
			});
		}
	};
}
