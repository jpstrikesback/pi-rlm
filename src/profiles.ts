import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { buildExecPromptGuidelines, buildRoutingFewShotBlock, buildRoutingLadderBlock } from "./experiment-flags.js";
import { parseModelSelector } from "./recursion.js";
import type {
	LlmQueryBudgetPreset,
	RlmExecutionProfile,
	RlmExternalizationKernelMode,
	RlmProfilePromptOverrides,
	RlmResolvedExecutionProfile,
	RlmRootKickoffVariant,
	RlmTaskFewShotVariant,
	RlmThinkingLevel,
	RlmModelSelector,
} from "./types.js";

const DEFAULT_PROFILE_NAME = "openai-5.4-class";
const RLM_PROFILE_TYPE = "rlm-profile";
const RLM_PROFILE_CONFIG_FILE = "rlm-config.json";
const BUILTIN_PROFILE_FILE_CANDIDATES = [
	fileURLToPath(new URL("../rlm-profiles.json", import.meta.url)),
	fileURLToPath(new URL("../../rlm-profiles.json", import.meta.url)),
];

function resolveBuiltinProfilePath(): string {
	for (const candidate of BUILTIN_PROFILE_FILE_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("Unable to locate rlm-profiles.json");
}

type ModelRegistryLike = {
	find: (provider: string, id: string) => unknown;
	getApiKeyAndHeaders: (model: any) => Promise<{ ok: boolean; error?: string }>;
};

export type RlmProfileRegistry = Record<string, RlmExecutionProfile>;
type SimpleChildHelpers = NonNullable<RlmExecutionProfile["helpers"]>["simpleChild"];
type RecursiveChildHelpers = NonNullable<RlmExecutionProfile["helpers"]>["recursiveChild"];
type GuidanceVariant = "default" | "direct-tools-first" | "recursive-first";

export function resolveRlmProfileConfigPaths(
	baseDir: string = process.cwd(),
	explicitConfigPath?: string,
): string[] {
	const project = resolve(baseDir, ".pi", "agent", RLM_PROFILE_CONFIG_FILE);
	const global = resolve(homedir(), ".pi", "agent", RLM_PROFILE_CONFIG_FILE);
	if (explicitConfigPath) {
		const normalizedExplicit = resolve(explicitConfigPath);
		const output = [global, project];
		if (normalizedExplicit !== project && normalizedExplicit !== global) output.push(normalizedExplicit);
		return Array.from(new Set(output));
	}
	if (project === global) return [project];
	return [global, project];
}

export function loadRlmProfileConfigFromPath(filePath: string): RlmProfileRegistry {
	if (!existsSync(filePath)) return Object.create(null);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Unable to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return normalizeProfileMap(parsed);
}

export type RlmProfileConfigFile = {
	version?: number | string;
	profiles?: Record<string, RlmExecutionProfile>;
};

export function resolveRlmProfileConfigPathForWrite(
	baseDir: string = process.cwd(),
	explicitConfigPath?: string,
): string {
	if (explicitConfigPath) return resolve(explicitConfigPath);
	return resolve(baseDir, ".pi", "agent", RLM_PROFILE_CONFIG_FILE);
}

export function writeRlmProfileConfigFile(filePath: string, profiles: RlmProfileRegistry): void {
	const payload: RlmProfileConfigFile = {
		version: 1,
		profiles,
	};
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function normalizeProfileForConfig(name: string, input: unknown): RlmExecutionProfile {
	return normalizeProfile(input, name);
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return Object.create(null);
	return value as Record<string, unknown>;
}

function normalizeBias(value: unknown): "high" | "medium" | "low" {
	return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeThinking(value: unknown): RlmThinkingLevel | undefined {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
		? value
		: undefined;
}

function normalizeBudget(value: unknown): LlmQueryBudgetPreset | undefined {
	return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeBehavior(input: unknown): RlmExecutionProfile["behavior"] {
	const raw = asRecord(input);
	return {
		guidanceVariant: isString(raw.guidanceVariant) ? raw.guidanceVariant : "default",
		taskFewShotVariant: normalizeTaskFewShotVariant(raw.taskFewShotVariant),
		rootKickoffVariant: normalizeRootKickoffVariant(raw.rootKickoffVariant),
		directToolBias: normalizeBias(raw.directToolBias),
		runtimeBias: normalizeBias(raw.runtimeBias),
		recursiveBias: normalizeBias(raw.recursiveBias),
		shortestExecProgram:
			raw.shortestExecProgram === true || raw.shortestExecProgram === false ? raw.shortestExecProgram : true,
		avoidManualScanSubstitution:
			raw.avoidManualScanSubstitution === true || raw.avoidManualScanSubstitution === false
				? raw.avoidManualScanSubstitution
				: true,
		simplifyAfterOptionalFailure:
			raw.simplifyAfterOptionalFailure === true || raw.simplifyAfterOptionalFailure === false
				? raw.simplifyAfterOptionalFailure
				: true,
	};
}

function normalizeGuidanceVariant(value: unknown): GuidanceVariant {
	return value === "direct-tools-first" || value === "recursive-first" || value === "default" ? value : "default";
}

function normalizeTaskFewShotVariant(value: unknown): RlmTaskFewShotVariant {
	return value === "artifact-workflow-neutral-v1" ||
		value === "artifact-workflow-openai-v1" ||
		value === "artifact-workflow-local-v1" ||
		value === "none"
		? value
		: "none";
}

function normalizeRootKickoffVariant(value: unknown): RlmRootKickoffVariant {
	return value === "recursive-scout-v1" || value === "recursive-chain-v1" || value === "none" ? value : "none";
}

function normalizeSimpleChild(input: unknown): NonNullable<SimpleChildHelpers> {
	const raw = asRecord(input);
	return {
		defaultModel: isString(raw.defaultModel) ? (raw.defaultModel as RlmModelSelector) : undefined,
		thinking: normalizeThinking(raw.thinking),
		budget: normalizeBudget(raw.budget),
	};
}

function normalizeRecursiveChild(input: unknown): NonNullable<RecursiveChildHelpers> {
	const raw = asRecord(input);
	return {
		defaultModel: isString(raw.defaultModel) ? (raw.defaultModel as RlmModelSelector) : undefined,
		inheritParentByDefault:
			raw.inheritParentByDefault === true || raw.inheritParentByDefault === false ? raw.inheritParentByDefault : false,
		thinking: normalizeThinking(raw.thinking),
		budget: normalizeBudget(raw.budget),
	};
}

function normalizePromptModeOverride<T>(input: unknown, normalizeValue: (value: unknown) => T | undefined): { current?: T; "no-subcalls"?: T } | undefined {
	const raw = asRecord(input);
	const current = normalizeValue(raw.current);
	const noSubcalls = normalizeValue(raw["no-subcalls"]);
	if (current === undefined && noSubcalls === undefined) return undefined;
	return {
		...(current !== undefined ? { current } : {}),
		...(noSubcalls !== undefined ? { "no-subcalls": noSubcalls } : {}),
	};
}

function normalizePromptBlock(input: unknown): { root?: string; exec?: string } | undefined {
	const raw = asRecord(input);
	const root = isString(raw.root) ? String(raw.root) : undefined;
	const exec = isString(raw.exec) ? String(raw.exec) : undefined;
	if (!root && !exec) return undefined;
	return { ...(root ? { root } : {}), ...(exec ? { exec } : {}) };
}

function normalizeStringArray(input: unknown): string[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const lines = input.filter((value): value is string => isString(value)).map((value) => String(value));
	return lines.length > 0 ? lines : undefined;
}

function normalizePromptOverrides(input: unknown): RlmProfilePromptOverrides {
	const raw = asRecord(input);
	return {
		...(normalizePromptModeOverride(raw.rootKickoff, normalizePromptBlock)
			? { rootKickoff: normalizePromptModeOverride(raw.rootKickoff, normalizePromptBlock)! }
			: {}),
		...(normalizePromptModeOverride(raw.taskFewShot, normalizePromptBlock)
			? { taskFewShot: normalizePromptModeOverride(raw.taskFewShot, normalizePromptBlock)! }
			: {}),
		...(normalizePromptModeOverride(raw.execPromptSnippet, (value) => (isString(value) ? String(value) : undefined))
			? { execPromptSnippet: normalizePromptModeOverride(raw.execPromptSnippet, (value) => (isString(value) ? String(value) : undefined))! }
			: {}),
		...(normalizePromptModeOverride(raw.execCodeParamDescription, (value) => (isString(value) ? String(value) : undefined))
			? { execCodeParamDescription: normalizePromptModeOverride(raw.execCodeParamDescription, (value) => (isString(value) ? String(value) : undefined))! }
			: {}),
		...(normalizePromptModeOverride(raw.legacyDenseExecGuidelineLines, normalizeStringArray)
			? { legacyDenseExecGuidelineLines: normalizePromptModeOverride(raw.legacyDenseExecGuidelineLines, normalizeStringArray)! }
			: {}),
	};
}

function normalizeFallback(input: unknown): RlmExecutionProfile["fallback"] {
	const raw = asRecord(input);
	const onMissingSimpleChildModel =
		raw.onMissingSimpleChildModel === "fail" ||
		raw.onMissingSimpleChildModel === "warn-and-inherit" ||
		raw.onMissingSimpleChildModel === "warn-and-disable"
			? raw.onMissingSimpleChildModel
			: "warn-and-inherit";
	const onMissingRecursiveChildModel =
		raw.onMissingRecursiveChildModel === "fail" ||
		raw.onMissingRecursiveChildModel === "warn-and-inherit" ||
		raw.onMissingRecursiveChildModel === "warn-and-disable"
			? raw.onMissingRecursiveChildModel
			: "warn-and-inherit";
	return { onMissingSimpleChildModel, onMissingRecursiveChildModel };
}

function normalizeProfile(raw: unknown, fallbackName: string): RlmExecutionProfile {
	const value = asRecord(raw);
	const rawHelpers = asRecord(value.helpers);
	return {
		name: isString(value.name) ? String(value.name) : fallbackName,
		...(isString(value.description) ? { description: String(value.description) } : {}),
		behavior: normalizeBehavior(asRecord(value.behavior)),
		helpers: {
			simpleChild: normalizeSimpleChild(rawHelpers.simpleChild),
			recursiveChild: normalizeRecursiveChild(rawHelpers.recursiveChild),
		},
		fallback: normalizeFallback(value.fallback),
		promptOverrides: normalizePromptOverrides(value.promptOverrides),
	};
}

function normalizeProfileMap(raw: unknown): RlmProfileRegistry {
	const input = asRecord(raw);
	const hasWrappedProfiles = Object.prototype.hasOwnProperty.call(input, "profiles");
	const wrapped = asRecord((input as { profiles?: unknown }).profiles);
	const source = hasWrappedProfiles ? wrapped : input;
	const output: RlmProfileRegistry = Object.create(null);
	for (const [name, candidate] of Object.entries(source)) {
		if (!isString(name) || name === "name" || name === "version" || !candidate || typeof candidate !== "object")
			continue;
		output[name] = normalizeProfile(candidate, name);
	}
	return output;
}

function loadBuiltinProfiles(): RlmProfileRegistry {
	const raw = readFileSync(resolveBuiltinProfilePath(), "utf8");
	const parsed = JSON.parse(raw) as unknown;
	const profiles = normalizeProfileMap(parsed);
	if (Object.keys(profiles).length === 0) throw new Error("No profiles were loaded from rlm-profiles.json");
	return profiles;
}

const BUILTIN_PROFILES = loadBuiltinProfiles();

function resolveProfileFromRegistry(profiles: RlmProfileRegistry, name?: string): RlmExecutionProfile {
	const requested = isString(name) ? name : DEFAULT_PROFILE_NAME;
	const selected =
		profiles[requested] ?? (requested !== DEFAULT_PROFILE_NAME ? profiles[DEFAULT_PROFILE_NAME] : undefined);
	if (selected) return selected;
	throw new Error(
		`Unknown profile: ${requested}. Available profiles: ${Object.keys(profiles)
			.map((entry) => `"${entry}"`)
			.join(", ")}`,
	);
}

function normalizeResolvedProfile(profile: RlmExecutionProfile): RlmResolvedExecutionProfile {
	const helperSettings = profile.helpers ?? {};
	const simpleChild = normalizeSimpleChild(helperSettings.simpleChild);
	const recursiveChild = normalizeRecursiveChild(helperSettings.recursiveChild);
	return {
		name: profile.name,
		description: profile.description,
		behavior: {
			guidanceVariant: profile.behavior.guidanceVariant,
			taskFewShotVariant: profile.behavior.taskFewShotVariant ?? "none",
			rootKickoffVariant: profile.behavior.rootKickoffVariant ?? "none",
			directToolBias: profile.behavior.directToolBias ?? "medium",
			runtimeBias: profile.behavior.runtimeBias ?? "medium",
			recursiveBias: profile.behavior.recursiveBias ?? "medium",
			shortestExecProgram: profile.behavior.shortestExecProgram === false ? false : true,
			avoidManualScanSubstitution: profile.behavior.avoidManualScanSubstitution === false ? false : true,
			simplifyAfterOptionalFailure: profile.behavior.simplifyAfterOptionalFailure === false ? false : true,
		},
		helpers: {
			simpleChild: {
				defaultModel: simpleChild.defaultModel,
				thinking: simpleChild.thinking,
				budget: simpleChild.budget,
				disabled: false,
			},
			recursiveChild: {
				defaultModel: recursiveChild.defaultModel,
				inheritParentByDefault: recursiveChild.inheritParentByDefault ?? true,
				thinking: recursiveChild.thinking,
				budget: recursiveChild.budget,
				disabled: false,
			},
		},
		fallback: {
			onMissingSimpleChildModel: profile.fallback?.onMissingSimpleChildModel ?? "warn-and-inherit",
			onMissingRecursiveChildModel: profile.fallback?.onMissingRecursiveChildModel ?? "warn-and-inherit",
		},
		promptOverrides: profile.promptOverrides ?? {},
	};
}

export function mergeProfiles(customProfiles?: Record<string, RlmExecutionProfile>): RlmProfileRegistry {
	if (!customProfiles || Object.keys(customProfiles).length === 0) return { ...BUILTIN_PROFILES };
	const next: RlmProfileRegistry = { ...BUILTIN_PROFILES };
	for (const [name, profile] of Object.entries(customProfiles)) {
		if (!name || typeof name !== "string" || !profile) continue;
		next[name] = normalizeProfile(profile, name);
	}
	return next;
}

// Internal to the extension runtime; not intended as a package-level API surface.
export function resolveProfile(
	name?: string,
	customProfiles?: Record<string, RlmExecutionProfile>,
): RlmResolvedExecutionProfile {
	const profiles = mergeProfiles(customProfiles);
	return normalizeResolvedProfile(resolveProfileFromRegistry(profiles, name));
}

export function getBuiltinProfiles(): RlmProfileRegistry {
	return { ...BUILTIN_PROFILES };
}

export async function validateProfileSelectors(
	profile: RlmResolvedExecutionProfile,
	modelRegistry: ModelRegistryLike,
): Promise<void> {
	for (const selector of [profile.helpers.simpleChild.defaultModel, profile.helpers.recursiveChild.defaultModel]) {
		if (!selector) continue;
		const parsed = parseModelSelector(selector);
		const model = modelRegistry.find(parsed.provider, parsed.id);
		if (!model) {
			throw new Error(`Profile ${profile.name} references unknown model selector ${selector}`);
		}
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(
				`Profile ${profile.name} model selector ${selector} has no usable auth: ${auth.error ?? "missing credentials"}`,
			);
		}
	}
}

function renderBulletBlock(lines: string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

function getPromptModeValue<T>(
	override: { current?: T; "no-subcalls"?: T } | undefined,
	externalizationKernel: RlmExternalizationKernelMode,
): T | undefined {
	return externalizationKernel === "no-subcalls" ? override?.["no-subcalls"] : override?.current;
}

function buildRootKickoffBlocks(
	profile: RlmResolvedExecutionProfile,
	options: { externalizationKernel: RlmExternalizationKernelMode; root: boolean },
): {
	rootBlock?: string;
	execBlock?: string;
} {
	if (!options.root) return {};
	const promptOverride = getPromptModeValue(profile.promptOverrides.rootKickoff, options.externalizationKernel);
	if (promptOverride) return { rootBlock: promptOverride.root, execBlock: promptOverride.exec };
	const isNoSubcalls = options.externalizationKernel === "no-subcalls";
	switch (profile.behavior.rootKickoffVariant) {
		case "recursive-scout-v1":
			return {
				rootBlock: [
					"Root kickoff policy:",
					renderBulletBlock([
						isNoSubcalls
							? "For nontrivial tasks, enter rlm_exec early and use it as the root coordination surface; child-query helpers are disabled in this mode, so do not promise recursive scouts."
							: "For nontrivial tasks, do not keep all decomposition in the root transcript. Enter rlm_exec early and launch an initial rlm_query scout before the main leaf-work pass.",
						isNoSubcalls
							? "Build a compact plan, constraints list, and evidence skeleton in workspace state before major leaf work."
							: "Ask the scout for a compact decomposition, risk map, or critique seed, commit the result, then continue from that stored state.",
						"Skip this kickoff on trivial one-shot tasks.",
					]),
					...(isNoSubcalls
						? []
						: [
								"Example kickoff sketch:",
								'```js\nconst scout = await rlm_query({\n  prompt: "Decompose this nontrivial task into concrete subproblems and return a compact plan or critique seed.",\n  role: "planner",\n  tools: "coding",\n  budget: "medium",\n});\nglobalThis.workspace.commit({\n  plan: [scout.summary ?? scout.answer],\n  findings: [`Scout: ${scout.summary ?? scout.answer}`],\n});\n```',
							]),
				].join("\n"),
				execBlock: [
					"Root kickoff mirror:",
					renderBulletBlock([
						isNoSubcalls
							? "In no-subcalls mode, simulate the kickoff by creating and committing a compact plan/evidence scaffold before major leaf work."
							: "At the start of a nontrivial task, make one early rlm_query scout for decomposition/critique, commit it, then continue the main plan from workspace state.",
					]),
				].join("\n"),
			};
		case "recursive-chain-v1":
			return {
				rootBlock: [
					"Root kickoff policy:",
					"Loop: decompose -> solve branches -> compose -> review -> recompose.",
					renderBulletBlock([
						isNoSubcalls
							? "For nontrivial tasks, start in rlm_exec, write the decomposition into workspace state, and continue there because child-query helpers are disabled in this mode."
							: "For nontrivial tasks, start in rlm_exec and make one planner rlm_query before the main work.",
						isNoSubcalls
							? "Use workspace state as the decomposition notebook and keep the current constraints there."
							: "Solve hard branches with rlm_query, use llm_query only for bounded substeps inside a branch, and use direct tools for grounded work.",
						isNoSubcalls
							? "Compose and recompose in rlm_exec from committed workspace state."
							: "Compose in rlm_exec from committed child outputs and workspace state, not only from root-local reasoning.",
						isNoSubcalls
							? "After preview or critique, commit selected fixes and preserved constraints into workspace state before revising."
							: "After preview or critique, make one reviewer rlm_query before revising, then recompose in rlm_exec from the committed review output while preserving committed constraints.",
						"Skip this kickoff on trivial one-shot tasks.",
						"Do not do all five phases only in root-local reasoning when child queries are available.",
					]),
				].join("\n"),
				execBlock: [
					"Root kickoff mirror:",
					"Loop: decompose -> solve branches -> compose -> review -> recompose.",
					renderBulletBlock([
						isNoSubcalls
							? "In no-subcalls mode, commit the decomposition, the review notes, and the preserved constraints into workspace state before each major compose or recompose step."
							: "At the start of a nontrivial task, make one planner rlm_query inside rlm_exec before the main work.",
						isNoSubcalls
							? "Use direct tools for grounded work and workspace state for preservation."
							: "Use rlm_query for hard branches, llm_query only for bounded substeps, and direct tools for grounded work.",
						isNoSubcalls
							? "Recompose from committed review notes and preserved constraints."
							: "After the first composition, make one reviewer rlm_query before revising, then recompose from committed review output and preserved constraints.",
						"Do not satisfy this policy with purely local root reasoning when helper execution is available.",
					]),
				].join("\n"),
			};
		case "none":
		default:
			return {};
	}
}

function buildTaskFewShotBlocks(
	profile: RlmResolvedExecutionProfile,
	externalizationKernel: RlmExternalizationKernelMode,
): {
	rootBlock?: string;
	execBlock?: string;
} {
	const promptOverride = getPromptModeValue(profile.promptOverrides.taskFewShot, externalizationKernel);
	if (promptOverride) return { rootBlock: promptOverride.root, execBlock: promptOverride.exec };
	const isNoSubcalls = externalizationKernel === "no-subcalls";
	switch (profile.behavior.taskFewShotVariant) {
		case "artifact-workflow-openai-v1": {
			return {
				rootBlock: [
					"Task-family workflow few-shot (profile-owned, fixed across tasks):",
					"Loop: decompose -> solve branches -> compose -> review -> recompose.",
					renderBulletBlock([
						"For nontrivial artifact tasks, do not jump straight to a full final artifact.",
						isNoSubcalls
							? "Decompose in rlm_exec by committing a compact plan and constraints into workspace state."
							: "Decompose in rlm_exec with one planner rlm_query before the main work.",
						isNoSubcalls
							? "Solve grounded work with direct tools and keep branch decisions in workspace state."
							: "Solve hard branches with rlm_query, use llm_query only for bounded substeps, and use direct tools for grounded work.",
						isNoSubcalls
							? "Compose the first pass in rlm_exec from committed plan and constraints."
							: "Compose the first pass in rlm_exec from committed child outputs and workspace state.",
						isNoSubcalls
							? "After preview or critique, commit selected fixes and preserved constraints before revising."
							: "After preview or critique, make one reviewer rlm_query before revising.",
						"Recompose in rlm_exec from committed review output while preserving committed constraints and already-achieved gains unless the user changes them.",
						"Do not let required structure disappear during recomposition.",
					]),
				].join("\n"),
				execBlock: [
					"Workflow mirror (compact):",
					"Loop: decompose -> solve branches -> compose -> review -> recompose.",
					renderBulletBlock([
						isNoSubcalls
							? "Artifact tasks: commit plan and constraints -> compose first pass -> commit review notes -> recompose -> finalize."
							: "Artifact tasks: planner rlm_query -> solve hard branches -> compose first pass -> reviewer rlm_query -> recompose -> finalize.",
						isNoSubcalls
							? "Use direct tools for grounded work and workspace state for preservation."
							: "Use llm_query only for bounded substeps inside a branch solver.",
						"Preserve committed constraints and required components across recomposition.",
					]),
				].join("\n"),
			};
		}
		case "artifact-workflow-local-v1": {
			return {
				rootBlock: [
					"Task-family workflow few-shot (profile-owned, fixed across tasks):",
					"Example A — stateful artifact workflow",
					renderBulletBlock([
						"For nontrivial artifact work, enter rlm_exec before drafting the first full artifact.",
						"Prefer one early runtime pass with compact plan / constraints / critique state over a long transcript-only attempt.",
						isNoSubcalls
							? "Use direct tools and workspace state as the coordination substrate; child-query helpers are disabled in this mode."
							: "Use direct tools and workspace state as the default coordination substrate; only use llm_query or rlm_query when they clearly reduce work.",
						"Create a preview or first pass, record what to fix, commit it, then revise from that stored state.",
						"If you catch yourself about to finalize without stored plan or critique, stop and create that state first.",
					]),
					"",
					"Example B — multi-part audit",
					renderBulletBlock([
						"For multi-part audits or investigations, enter rlm_exec before the repo scan turns into a long transcript.",
						"Group findings by subproblem, commit them, and integrate from workspace rather than rediscovering them later.",
						"Keep helper use sparse unless the task is genuinely branchable and the helper materially reduces work.",
					]),
				].join("\n"),
				execBlock: [
					"Workflow mirror (compact):",
					renderBulletBlock([
						"Inside rlm_exec, keep plan, constraints, and critique in workspace before and after each artifact pass.",
						isNoSubcalls
							? "Use direct tools plus workspace state for coordination; child-query helpers are disabled in this mode."
							: "Prefer direct tools plus workspace first; only use llm_query or rlm_query when clearly beneficial.",
						"Do not let a full draft or audit live only in transcript memory; commit reusable state before finalizing.",
					]),
				].join("\n"),
			};
		}
		case "artifact-workflow-neutral-v1": {
			return {
				rootBlock: [
					"Task-family workflow few-shot (profile-owned, fixed across tasks):",
					"Example A — multi-pass artifact request",
					renderBulletBlock([
						"When the task likely needs planning, critique, or multiple refinement passes, do not jump straight to one large final artifact.",
						"Enter rlm_exec once a durable plan or reusable intermediate state is needed.",
						"Keep a compact plan, constraints, and revision notes in workspace state.",
						isNoSubcalls
							? "Use direct leaf tools for grounded work and revise from the stored state because child-query helpers are disabled."
							: "Use helper roles only where they materially reduce work; the main win is durable state and reuse.",
						"Produce a first pass, critique it, commit the critique, then revise from that stored state.",
					]),
					"",
					"Example B — decomposable analysis or audit",
					renderBulletBlock([
						"When the request splits into multiple subquestions, gather findings into workspace state before composing the answer.",
						"Integrate from stored findings rather than rediscovering the same evidence.",
					]),
				].join("\n"),
				execBlock: [
					"Workflow mirror (compact):",
					renderBulletBlock([
						"Artifact tasks: plan -> first pass -> critique -> commit -> revise from stored state -> finalize.",
						isNoSubcalls
							? "Use direct tools and workspace state for the full loop in this mode."
							: "Use helper roles only where they materially reduce work.",
						"Analysis tasks: gather -> commit -> integrate from workspace instead of rediscovery.",
					]),
				].join("\n"),
			};
		}
		case "none":
		default:
			return {};
	}
}

function usesLegacyDenseExecContract(profile: RlmResolvedExecutionProfile): boolean {
	return profile.name === "mlx-qwopus-legacy-dense";
}

function buildLegacyDenseExecGuidelineLines(
	profile: RlmResolvedExecutionProfile,
	externalizationKernel: RlmExternalizationKernelMode,
): string[] {
	const promptOverride = getPromptModeValue(profile.promptOverrides.legacyDenseExecGuidelineLines, externalizationKernel);
	if (promptOverride) return promptOverride;
	const isNoSubcalls = externalizationKernel === "no-subcalls";
	return [
		"Use globalThis.workspace as the main notebook for durable state and globalThis.workspace.activeContext as the current working set; keep short-lived scratch values elsewhere only when useful.",
		"Track goal, plan, files, findings, openQuestions, partialOutputs, childArtifacts, and activeContext in globalThis.workspace when helpful.",
		"Treat prompt metadata as an index to runtime state, not as a replacement for runtime state.",
		isNoSubcalls
			? "Child-query helpers are disabled in this mode, so keep branch decisions and reusable outputs in workspace state instead of promising child calls."
			: "Child helper outputs live under globalThis.workspace.childArtifacts; review and reuse them before repeating child analysis.",
		isNoSubcalls
			? "After a grounded leaf-tool pass, consolidate the important parts into workspace.findings or workspace.partialOutputs before moving on."
			: "After child work, consolidate the important parts into workspace.findings or workspace.partialOutputs.",
		"Use direct Pi tools as leaf actions and return here to update the workspace.",
		"Use console.log() for compact inspection, not huge dumps.",
		...(isNoSubcalls
			? ["Budget presets still accept low, medium, or high for any internal planning helpers that remain available in this mode."]
			: [
				"Child helper calls use these exact forms: llm_query({ prompt, role, state, tools, budget, output }), rlm_query({ prompt, role, state, tools, budget, output }), or llmQuery({ prompt, role, state, tools, budget, output }).",
				"Tools presets are read-only, coding, same, or an explicit built-in tool list.",
				"Budget presets also accept low, medium, or high.",
				"Default child tools should usually be read-only unless mutation is required.",
			]),
	];
}

export function buildProfileExecPromptSnippet(
	profile: RlmResolvedExecutionProfile,
	options: { externalizationKernel?: RlmExternalizationKernelMode } = {},
): string {
	const externalizationKernel = options.externalizationKernel ?? "current";
	const promptOverride = getPromptModeValue(profile.promptOverrides.execPromptSnippet, externalizationKernel);
	if (promptOverride) return promptOverride;
	const isNoSubcalls = externalizationKernel === "no-subcalls";
	if (usesLegacyDenseExecContract(profile)) {
		return isNoSubcalls
			? "Use this as the persistent coordinator workspace for multi-file or multi-step tasks. Keep durable state in globalThis.workspace and globalThis.workspace.activeContext. Helpers: final(), inspectGlobals(), globalThis.workspace.commit({...})."
			: "Use this as the persistent coordinator workspace for multi-file or multi-step tasks. Keep durable state in globalThis.workspace and globalThis.workspace.activeContext. Helpers: final(), inspectGlobals(), llm_query({ prompt, ... }), rlm_query({ prompt, ... }), llmQuery({ prompt, ... }), globalThis.workspace.commit({...}).";
	}
	return isNoSubcalls
		? "Use this for durable runtime/workspace work with direct leaf-tool actions, short-lived variables, and no child-query helper calls. Prefer the shortest successful runtime program."
		: "Use this only when the task needs durable state, recursive subcalls, or a working set larger than the transcript should hold. Stay with direct tools for trivial one-shot tasks, and prefer the shortest successful runtime program.";
}

export function buildProfileExecCodeParamDescription(
	profile: RlmResolvedExecutionProfile,
	options: { externalizationKernel?: RlmExternalizationKernelMode } = {},
): string {
	const externalizationKernel = options.externalizationKernel ?? "current";
	const promptOverride = getPromptModeValue(profile.promptOverrides.execCodeParamDescription, externalizationKernel);
	if (promptOverride) return promptOverride;
	const isNoSubcalls = externalizationKernel === "no-subcalls";
	if (usesLegacyDenseExecContract(profile)) {
		return isNoSubcalls
			? "JavaScript to execute. Runtime helpers include context/context.compiledContext, history/history_n, SHOW_VARS, FINAL, FINAL_VAR, inspectGlobals, final, and globalThis.workspace.commit({...}). Use globalThis.workspace as the durable coordinator notebook and globalThis.workspace.activeContext as the current working set. Treat prompt metadata as an index to runtime state, not as a replacement. Child-query helpers are disabled in this mode; use direct leaf actions, runtime variables, and workspace consolidation instead."
			: "JavaScript to execute. Runtime helpers include context/context.compiledContext, history/history_n, llm_query, llm_query_batched, rlm_query, rlm_query_batched, llmQuery, SHOW_VARS, FINAL, FINAL_VAR, inspectGlobals, final, and globalThis.workspace.commit({...}). Use globalThis.workspace as the durable coordinator notebook and globalThis.workspace.activeContext as the current working set. Treat prompt metadata as an index to runtime state, not as a replacement. Child helper calls use the exact forms llm_query({ prompt, role, state, tools, budget, output }), rlm_query({ prompt, role, state, tools, budget, output }), or llmQuery({ prompt, role, state, tools, budget, output }). Tools presets are read-only, coding, same, or an explicit built-in tool list; budget presets also accept low, medium, or high.";
	}
	return isNoSubcalls
		? "JavaScript to execute. Runtime helpers include context/context.compiledContext, history/history_n, SHOW_VARS, FINAL, FINAL_VAR, inspectGlobals, final, and globalThis.workspace.commit({...}). Child-query helpers are disabled in this mode; use direct leaf actions, runtime variables/buffers, and deterministic compiled workspace context instead. Prefer the shortest successful runtime program; avoid file writes or extra persistence ceremony unless the task explicitly requires them."
		: "JavaScript to execute. Runtime helpers include context/context.compiledContext, history/history_n, llm_query, llm_query_batched, rlm_query, rlm_query_batched, llmQuery, SHOW_VARS, FINAL, FINAL_VAR, inspectGlobals, final, and globalThis.workspace.commit({...}). Treat history as metadata-only fallback, not replay memory. If the task explicitly requests llm_query or rlm_query, call those helpers directly unless they are actually blocked; avoid file writes or extra persistence ceremony unless the task explicitly requires them.";
}

function buildGuidanceBlocks(
	profile: RlmResolvedExecutionProfile,
	options: { externalizationKernel: RlmExternalizationKernelMode; root: boolean },
): {
	routingLadderBlock: string;
	routingFewShotBlock: string;
	profileGuidanceLines: string[];
	rootKickoffBlock?: string;
	execRootKickoffBlock?: string;
	taskFewShotBlock?: string;
	execTaskFewShotBlock?: string;
} {
	const { externalizationKernel, root } = options;
	const isNoSubcalls = externalizationKernel === "no-subcalls";
	const variant = normalizeGuidanceVariant(profile.behavior.guidanceVariant);
	const simpleBias = profile.behavior.directToolBias;
	const runtimeBias = profile.behavior.runtimeBias;
	const recursiveBias = profile.behavior.recursiveBias;
	const { rootBlock: rootKickoffBlock, execBlock: execRootKickoffBlock } = buildRootKickoffBlocks(profile, {
		externalizationKernel,
		root,
	});
	const { rootBlock: taskFewShotBlock, execBlock: execTaskFewShotBlock } = buildTaskFewShotBlocks(
		profile,
		externalizationKernel,
	);
	let ladderLines: string[];
	let doLines: string[];
	let doNotLines: string[];
	switch (variant) {
		case "direct-tools-first":
			ladderLines = [
				`Use direct Pi tools first with ${simpleBias} bias for simple grounded tasks, short lookups, and quick edits.`,
				`Open rlm_exec when direct tools are insufficient: durable state, explicit coordination needs, or recursively decomposable work.`,
				isNoSubcalls
					? "In no-subcalls mode, keep work inside rlm_exec with direct leaf tools and workspace/runtime state; child-query helpers are disabled."
					: "Use rlm_query for recursive subproblems, and use llm_query only when a direct-call shortcut would be wasteful.",
			];
			doLines = [
				"Do: stay with direct tools by default, and only call helper queries when the task explicitly requires decomposition.",
				isNoSubcalls
					? "Do: for a stateful task, enter rlm_exec, use direct leaf tools, keep reusable state in workspace/runtime variables, commit durable findings, then answer."
					: "Do: call rlm_exec early for multi-step tasks, then use llm_query or rlm_query only where they materially reduce work.",
				isNoSubcalls
					? "Do: for multi-pass artifact work, keep a compact plan and critique in workspace/runtime state, then revise the artifact from that stored state."
					: "Do: for decomposable artifact tasks with subparts and critique/revision loops, enter rlm_exec early, keep a compact plan in state, use llm_query for bounded motif/component ideas, use rlm_query for harder composition decisions, then compose from stored results.",
			];
			doNotLines = [
				isNoSubcalls
					? "Do not replace simple direct-tool work with repeated rlm_exec probing or unnecessary workspace ceremony."
					: "Do not use helper calls for every local step when direct tools can complete the task faster.",
				"Do not jump straight from a vague artifact request to one large final file when a short plan, component decisions, or preview-driven critique would reduce rework.",
			];
			break;
		case "recursive-first":
			ladderLines = [
				`Open rlm_exec with ${runtimeBias} bias for tasks that benefit from decomposition, recursive structure, or long-lived state.`,
				`Use llm_query with ${simpleBias} bias for bounded extraction and rlm_query with ${recursiveBias} bias for recursive decomposition.`,
				isNoSubcalls
					? "In no-subcalls mode, keep work inside rlm_exec with direct leaf tools and workspace/runtime state; child-query helpers are disabled."
					: "Prefer calling helper queries as soon as a branchable subproblem is identified.",
			];
			doLines = [
				"Do: enter rlm_exec early for tasks that need recursive decomposition or coordination.",
				isNoSubcalls
					? "Do: for a stateful task, enter rlm_exec, use direct leaf tools, keep reusable state in workspace/runtime variables, commit durable findings, then answer."
					: "Do: call llm_query for bounded extraction and rlm_query for deeper recursive subproblems.",
				isNoSubcalls
					? "Do: for multi-pass artifact work, keep a compact plan and critique in workspace/runtime state, then revise from that stored state."
					: "Do: for compositional artifact tasks, solve motif/component ideas separately, reserve rlm_query for the hardest integration choice, then make the final artifact reflect those stored decisions.",
			];
			doNotLines = [
				isNoSubcalls
					? "Do not replace simple direct-tool tasks with unnecessary rlm_exec loops or workspace ceremony."
					: "Do not avoid direct tools entirely when the task is trivial and already scoped.",
				"Do not let helper outputs disappear; reuse them explicitly in the final composition or revision step.",
			];
			break;
		case "default":
		default:
			ladderLines = [
				"Direct Pi tools first for simple grounded work, one-shot lookups, and short read/edit tasks.",
				"Use rlm_exec when the task needs durable state, multi-step coordination, or a working set larger than the transcript should hold.",
				isNoSubcalls
					? "In no-subcalls mode, keep working inside rlm_exec with direct leaf tools and workspace/runtime state; child-query helpers are disabled."
					: "Inside rlm_exec, use llm_query for bounded lightweight side-computation and rlm_query for deeper decomposable subproblems.",
			];
			doLines = [
				"Do: for a simple grounded task, stay with direct tools and answer without entering rlm_exec.",
				isNoSubcalls
					? "Do: for a stateful task, enter rlm_exec, use direct leaf tools, keep reusable state in workspace/runtime variables, commit durable findings, then answer."
					: "Do: if the task explicitly asks for llm_query or rlm_query, enter rlm_exec, call those helpers directly, commit the result, then answer.",
				isNoSubcalls
					? "Do: for artifact tasks that need planning, visual critique, or multiple refinement passes, keep the plan and critique in state and revise from that stored state."
					: "Do: for artifact tasks with multiple subparts or critique/revision loops, enter rlm_exec once you need a durable plan, use llm_query for bounded motif ideas and rlm_query for the hardest composition choice, then compose from stored results.",
			];
			doNotLines = [
				isNoSubcalls
					? "Do not replace a simple direct-tool task with repeated rlm_exec probing or unnecessary workspace ceremony."
					: "Do not replace explicitly requested llm_query/rlm_query work with manual repo scanning unless helper execution is actually blocked.",
				"Do not jump straight to one large artifact draft when a short plan, a few component decisions, or a preview-driven critique would reduce rework.",
			];
	}
	const profileGuidanceLines = [
		`Policy biases: direct ${simpleBias}, runtime ${runtimeBias}, recursive ${recursiveBias}.`,
		profile.helpers.simpleChild.disabled
			? "Simple child defaults are disabled by policy."
			: `Simple child default: ${profile.helpers.simpleChild.defaultModel ? "configured by profile" : "inherit parent via fallback"}.`,
		profile.helpers.recursiveChild.disabled
			? "Recursive child defaults are disabled by policy."
			: `Recursive child default: ${profile.helpers.recursiveChild.defaultModel ? "configured by profile" : "inherit parent by default"}.`,
	];
	if (profile.behavior.taskFewShotVariant !== "none") {
		profileGuidanceLines.push(`Task-family few-shot variant: ${profile.behavior.taskFewShotVariant}.`);
	}
	if (usesLegacyDenseExecContract(profile)) {
		profileGuidanceLines.push("Exec tool contract: legacy-dense MLX coordinator guidance.");
	}
	if (root && profile.behavior.rootKickoffVariant !== "none") {
		profileGuidanceLines.push(`Root kickoff variant: ${profile.behavior.rootKickoffVariant}.`);
	}
	if (profile.behavior.shortestExecProgram)
		profileGuidanceLines.push("Prefer the shortest successful runtime helper sequence.");
	if (profile.behavior.avoidManualScanSubstitution)
		profileGuidanceLines.push("Prefer helper-invoked discovery over manual scan substitution.");
	if (profile.behavior.simplifyAfterOptionalFailure)
		profileGuidanceLines.push("On optional failure, simplify and continue with a shorter path.");
	return {
		routingLadderBlock: buildRoutingLadderBlock({ externalizationKernel, lines: ladderLines }),
		routingFewShotBlock: buildRoutingFewShotBlock({ externalizationKernel, doLines, doNotLines }),
		profileGuidanceLines,
		rootKickoffBlock,
		execRootKickoffBlock,
		taskFewShotBlock,
		execTaskFewShotBlock,
	};
}

export function buildProfileGuidance(
	profile: RlmResolvedExecutionProfile,
	options: { externalizationKernel?: RlmExternalizationKernelMode; root?: boolean } = {},
): string {
	const externalizationKernel = options.externalizationKernel ?? "current";
	const root = options.root ?? true;
	const lines: string[] = [];
	const { routingLadderBlock, routingFewShotBlock, profileGuidanceLines, rootKickoffBlock, taskFewShotBlock } =
		buildGuidanceBlocks(profile, { externalizationKernel, root });
	lines.push(`Execution profile: ${profile.name}.`);
	if (profile.description) lines.push(profile.description);
	lines.push(
		`Child-role policy: choose direct tools for simple grounded work and helper roles for recursive decomposition.`,
	);
	lines.push(...profileGuidanceLines);
	if (rootKickoffBlock) lines.push(rootKickoffBlock);
	if (taskFewShotBlock) lines.push(taskFewShotBlock);
	lines.push(routingLadderBlock, routingFewShotBlock);
	return lines.join("\n\n");
}

export function buildProfileExecGuidelines(
	profile: RlmResolvedExecutionProfile,
	options: {
		externalizationKernel?: RlmExternalizationKernelMode;
		root?: boolean;
	} = {},
): string[] {
	const externalizationKernel = options.externalizationKernel ?? "current";
	const root = options.root ?? true;
	const { routingLadderBlock, routingFewShotBlock, profileGuidanceLines, execRootKickoffBlock, execTaskFewShotBlock } =
		buildGuidanceBlocks(profile, { externalizationKernel, root });
	const execProfileLines = [
		...profileGuidanceLines,
		...(usesLegacyDenseExecContract(profile) ? buildLegacyDenseExecGuidelineLines(profile, externalizationKernel) : []),
		...(execRootKickoffBlock ? [execRootKickoffBlock] : []),
		...(execTaskFewShotBlock ? [execTaskFewShotBlock] : []),
	];
	return buildExecPromptGuidelines({
		externalizationKernel,
		routingLadderBlock,
		routingFewShotBlock,
		profileGuidanceLines: execProfileLines,
	});
}

export function materializeProfilePromptOverrides(profile: RlmResolvedExecutionProfile): RlmProfilePromptOverrides {
	const currentRootKickoff = buildRootKickoffBlocks(profile, { externalizationKernel: "current", root: true });
	const noSubcallsRootKickoff = buildRootKickoffBlocks(profile, { externalizationKernel: "no-subcalls", root: true });
	const currentTaskFewShot = buildTaskFewShotBlocks(profile, "current");
	const noSubcallsTaskFewShot = buildTaskFewShotBlocks(profile, "no-subcalls");
	return {
		...(currentRootKickoff.rootBlock || currentRootKickoff.execBlock || noSubcallsRootKickoff.rootBlock || noSubcallsRootKickoff.execBlock
			? {
				rootKickoff: {
					...(currentRootKickoff.rootBlock || currentRootKickoff.execBlock
						? { current: { ...(currentRootKickoff.rootBlock ? { root: currentRootKickoff.rootBlock } : {}), ...(currentRootKickoff.execBlock ? { exec: currentRootKickoff.execBlock } : {}) } }
						: {}),
					...(noSubcallsRootKickoff.rootBlock || noSubcallsRootKickoff.execBlock
						? { "no-subcalls": { ...(noSubcallsRootKickoff.rootBlock ? { root: noSubcallsRootKickoff.rootBlock } : {}), ...(noSubcallsRootKickoff.execBlock ? { exec: noSubcallsRootKickoff.execBlock } : {}) } }
						: {}),
				},
			}
			: {}),
		...(currentTaskFewShot.rootBlock || currentTaskFewShot.execBlock || noSubcallsTaskFewShot.rootBlock || noSubcallsTaskFewShot.execBlock
			? {
				taskFewShot: {
					...(currentTaskFewShot.rootBlock || currentTaskFewShot.execBlock
						? { current: { ...(currentTaskFewShot.rootBlock ? { root: currentTaskFewShot.rootBlock } : {}), ...(currentTaskFewShot.execBlock ? { exec: currentTaskFewShot.execBlock } : {}) } }
						: {}),
					...(noSubcallsTaskFewShot.rootBlock || noSubcallsTaskFewShot.execBlock
						? { "no-subcalls": { ...(noSubcallsTaskFewShot.rootBlock ? { root: noSubcallsTaskFewShot.rootBlock } : {}), ...(noSubcallsTaskFewShot.execBlock ? { exec: noSubcallsTaskFewShot.execBlock } : {}) } }
						: {}),
				},
			}
			: {}),
		execPromptSnippet: {
			current: buildProfileExecPromptSnippet(profile, { externalizationKernel: "current" }),
			"no-subcalls": buildProfileExecPromptSnippet(profile, { externalizationKernel: "no-subcalls" }),
		},
		execCodeParamDescription: {
			current: buildProfileExecCodeParamDescription(profile, { externalizationKernel: "current" }),
			"no-subcalls": buildProfileExecCodeParamDescription(profile, { externalizationKernel: "no-subcalls" }),
		},
		...(usesLegacyDenseExecContract(profile)
			? {
				legacyDenseExecGuidelineLines: {
					current: buildLegacyDenseExecGuidelineLines(profile, "current"),
					"no-subcalls": buildLegacyDenseExecGuidelineLines(profile, "no-subcalls"),
				},
			}
			: {}),
	};
}

export function findRlmProfileFromBranch(ctx: {
	sessionManager: { getBranch: () => Array<{ type?: string; customType?: string; data?: unknown }> };
}): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== RLM_PROFILE_TYPE) continue;
		const data = asRecord(entry.data);
		if (isString(data.profile)) return String(data.profile);
	}
	return undefined;
}
export { DEFAULT_PROFILE_NAME, RLM_PROFILE_TYPE, getBuiltinProfiles as builtinProfiles };
