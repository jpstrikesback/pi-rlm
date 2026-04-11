import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
	AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import {
	analyzeAssistantPathCitations,
	analyzeCommitTruthfulness,
	canonicalizeProviderPayload,
	computeRepeatedReadRatio,
	longestCommonPrefixChars,
	safeRatio,
} from "./eval/metrics.js";
import { findProviderProfile, getProviderProfiles } from "./eval/provider-profiles.js";
import { findScenario, getEvalScenarios, getPinnedPiVersion, getRepoRoot } from "./eval/scenarios.js";
import type {
	EvalCompareResult,
	EvalContextStats,
	EvalRunResult,
	EvalScenario,
	EvalSubmodelOverride,
	EvalToolEvent,
	EvalTurnResult,
	ProxyLogEntry,
	ProxyUsage,
} from "./eval/types.js";

type CliArgs = Record<string, string | boolean>;

type NativeRunOptions = {
	subjectEntrypoint: string;
	spyEntrypoint: string;
	subjectLabel: string;
	scenario: EvalScenario;
	modelId: string;
	providerProfile: ReturnType<typeof findProviderProfile>;
	modelProviderOverride?: string;
	authProviderOverride?: string;
	authAgentDir: string;
	isolatedAuth: boolean;
	apiKeySource?: string;
	reasoning: boolean;
};

type SpyEvent = {
	type: string;
	timestamp: string;
	sessionId?: string;
	turnIndex?: number;
	data?: unknown;
};

type SpyContextSample = {
	messageCount?: number;
	estimatedChars?: number;
};

type TurnWorkspaceStats = {
	commitCount: number;
	workspaceCommits: EvalTurnResult["workspaceCommits"];
	committedAfterLeafTools: boolean;
	committedBeforeLeafTools: boolean;
	workspaceState?: EvalTurnResult["workspaceState"];
};

async function main() {
	const [command = "help", ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);

	switch (command) {
		case "list":
		case "list-scenarios":
			printScenarios();
			return;
		case "snapshot-baseline":
			await snapshotBaseline(args);
			return;
		case "run":
			await runCommand(args);
			return;
		case "compare":
			await compareCommand(args);
			return;
		default:
			printHelp();
	}
}

async function runCommand(args: CliArgs) {
	const subject = requireArg(args, "subject");
	const scenarios = resolveScenarios(args.scenario);
	const providerProfile = findProviderProfile(stringArg(args, "providerProfile"));
	const modelId = requireArg(args, "modelId");
	const label = String(args.label ?? path.basename(subject));

	const extensionFlags = {
		...parseExtensionFlagsArg(stringArg(args, "extensionFlags")),
	};
	for (const scenario of scenarios) {
		const result = await runNativeScenario({
			subjectEntrypoint: subject,
			spyEntrypoint: requireArg(args, "spyEntrypoint"),
			subjectLabel: label,
			scenario: withScenarioExtensionFlags(scenario, extensionFlags),
			modelId,
			providerProfile,
			modelProviderOverride: stringArg(args, "modelProvider"),
			authProviderOverride: stringArg(args, "authProvider"),
			authAgentDir: resolveEvalAgentDir({ agentDir: stringArg(args, "agentDir") }),
			isolatedAuth: booleanArg(args, "isolatedAuth") ?? false,
			apiKeySource: stringArg(args, "apiKey"),
			reasoning: booleanArg(args, "reasoning") ?? false,
		});
		const out = await writeRunArtifacts(result, { outLabel: label });
		console.log(renderRunSummary(result, out));
	}
}

async function compareCommand(args: CliArgs) {
	const baseline = requireArg(args, "baseline");
	const candidate = requireArg(args, "candidate");
	const scenarios = resolveScenarios(args.scenario ?? "extension-research");
	const providerProfile = findProviderProfile(stringArg(args, "providerProfile"));
	const modelId = requireArg(args, "modelId");

	const commonExtensionFlags = {
		...parseExtensionFlagsArg(stringArg(args, "extensionFlags")),
	};
	const baselineExtensionFlags = {
		...commonExtensionFlags,
		...parseExtensionFlagsArg(stringArg(args, "baselineExtensionFlags")),
	};
	const candidateExtensionFlags = {
		...commonExtensionFlags,
		...parseExtensionFlagsArg(stringArg(args, "candidateExtensionFlags")),
	};
	for (const scenario of scenarios) {
		const shared = {
			spyEntrypoint: requireArg(args, "spyEntrypoint"),
			modelId,
			providerProfile,
			modelProviderOverride: stringArg(args, "modelProvider"),
			authProviderOverride: stringArg(args, "authProvider"),
			authAgentDir: resolveEvalAgentDir({ agentDir: stringArg(args, "agentDir") }),
			isolatedAuth: booleanArg(args, "isolatedAuth") ?? false,
			apiKeySource: stringArg(args, "apiKey"),
			reasoning: booleanArg(args, "reasoning") ?? false,
		} satisfies Omit<NativeRunOptions, "subjectEntrypoint" | "subjectLabel" | "scenario">;

		const baselineResult = await runNativeScenario({
			subjectEntrypoint: baseline,
			subjectLabel: String(args.baselineLabel ?? "baseline"),
			scenario: withScenarioExtensionFlags(scenario, baselineExtensionFlags),
			...shared,
		});
		const candidateResult = await runNativeScenario({
			subjectEntrypoint: candidate,
			subjectLabel: String(args.candidateLabel ?? "candidate"),
			scenario: withScenarioExtensionFlags(scenario, candidateExtensionFlags),
			...shared,
		});

		const compare: EvalCompareResult = {
			createdAt: new Date().toISOString(),
			harnessVersion: 1,
			baseline: baselineResult,
			candidate: candidateResult,
			delta: {
				durationMs: candidateResult.summary.totalDurationMs - baselineResult.summary.totalDurationMs,
				promptTokens: candidateResult.summary.promptTokens - baselineResult.summary.promptTokens,
				completionTokens: candidateResult.summary.completionTokens - baselineResult.summary.completionTokens,
				totalTokens: candidateResult.summary.totalTokens - baselineResult.summary.totalTokens,
				cacheHitTokens: candidateResult.summary.cacheHitTokens - baselineResult.summary.cacheHitTokens,
				cacheMissTokens: candidateResult.summary.cacheMissTokens - baselineResult.summary.cacheMissTokens,
				toolCalls: candidateResult.summary.totalToolCalls - baselineResult.summary.totalToolCalls,
				rlmExecCount: candidateResult.summary.totalRlmExecCount - baselineResult.summary.totalRlmExecCount,
				childQueryCount: candidateResult.summary.totalChildQueryCount - baselineResult.summary.totalChildQueryCount,
				childTurns: candidateResult.summary.totalChildTurns - baselineResult.summary.totalChildTurns,
				attemptedSimpleQueryCount: candidateResult.summary.totalAttemptedSimpleQueryCount - baselineResult.summary.totalAttemptedSimpleQueryCount,
				attemptedSimpleBatchCount: candidateResult.summary.totalAttemptedSimpleBatchCount - baselineResult.summary.totalAttemptedSimpleBatchCount,
				attemptedRecursiveQueryCount: candidateResult.summary.totalAttemptedRecursiveQueryCount - baselineResult.summary.totalAttemptedRecursiveQueryCount,
				attemptedRecursiveBatchCount: candidateResult.summary.totalAttemptedRecursiveBatchCount - baselineResult.summary.totalAttemptedRecursiveBatchCount,
				simpleQueryCount: candidateResult.summary.totalSimpleQueryCount - baselineResult.summary.totalSimpleQueryCount,
				simpleBatchCount: candidateResult.summary.totalSimpleBatchCount - baselineResult.summary.totalSimpleBatchCount,
				recursiveQueryCount: candidateResult.summary.totalRecursiveQueryCount - baselineResult.summary.totalRecursiveQueryCount,
				recursiveBatchCount: candidateResult.summary.totalRecursiveBatchCount - baselineResult.summary.totalRecursiveBatchCount,
				submodelOverrideCount: candidateResult.summary.totalSubmodelOverrideCount - baselineResult.summary.totalSubmodelOverrideCount,
				showVarsCount: candidateResult.summary.totalShowVarsCount - baselineResult.summary.totalShowVarsCount,
				workspaceCommits: candidateResult.summary.totalWorkspaceCommits - baselineResult.summary.totalWorkspaceCommits,
				postLeafCommitRate: (candidateResult.summary.postLeafCommitRate ?? 0) - (baselineResult.summary.postLeafCommitRate ?? 0),
				falseCommitClaimTurns: candidateResult.summary.falseCommitClaimTurns - baselineResult.summary.falseCommitClaimTurns,
				missingPathCitations: candidateResult.summary.missingPathCitations - baselineResult.summary.missingPathCitations,
				pathExistenceRate: (candidateResult.summary.pathExistenceRate ?? 0) - (baselineResult.summary.pathExistenceRate ?? 0),
				runtimeNewBindingCount: candidateResult.summary.totalRuntimeNewBindingCount - baselineResult.summary.totalRuntimeNewBindingCount,
				runtimeUpdatedBindingCount: candidateResult.summary.totalRuntimeUpdatedBindingCount - baselineResult.summary.totalRuntimeUpdatedBindingCount,
				repeatedReadRatio: (candidateResult.summary.repeatedReadRatio ?? 0) - (baselineResult.summary.repeatedReadRatio ?? 0),
				staleRecoveryRate: (candidateResult.summary.staleRecoveryRate ?? 0) - (baselineResult.summary.staleRecoveryRate ?? 0),
				plateauRatio: (candidateResult.summary.plateauRatio ?? 0) - (baselineResult.summary.plateauRatio ?? 0),
			},
		};

		const out = await writeCompareArtifacts(compare);
		console.log(renderCompareSummary(compare, out));
	}
}

async function snapshotBaseline(args: CliArgs) {
	const name = String(args.name ?? `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	const source = path.resolve(String(args.source ?? path.join(getRepoRoot(), "dist")));
	const target = path.join(getRepoRoot(), "eval", "artifacts", name);
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	await cp(source, path.join(target, "dist"), { recursive: true });
	await writeFile(
		path.join(target, "metadata.json"),
		JSON.stringify({ createdAt: new Date().toISOString(), piVersion: getPinnedPiVersion(), source }, null, 2),
	);
	console.log(`Saved baseline artifact to ${target}`);
}

function replaceScenarioTokens(text: string, replacements: Record<string, string>): string {
	let next = text;
	for (const [token, value] of Object.entries(replacements)) {
		next = next.split(token).join(value);
	}
	return next;
}

async function materializeScenarioForRun(scenario: EvalScenario, runRoot: string): Promise<EvalScenario> {
	const runId = path.basename(runRoot);
	const svgOutputPath = path.join("eval", "generated", `${scenario.id}-${runId}.svg`);
	const svgPreviewPath = path.join("eval", "generated", `${scenario.id}-${runId}.png`);
	const replacements = {
		"{{SVG_OUTPUT_PATH}}": svgOutputPath,
		"{{SVG_PREVIEW_PATH}}": svgPreviewPath,
	};
	const absoluteSvgOutputPath = path.join(getRepoRoot(), svgOutputPath);
	const absoluteSvgPreviewPath = path.join(getRepoRoot(), svgPreviewPath);
	await mkdir(path.dirname(absoluteSvgOutputPath), { recursive: true });
	await rm(absoluteSvgOutputPath, { force: true });
	await rm(absoluteSvgPreviewPath, { force: true });
	return {
		...scenario,
		setupPrompts: scenario.setupPrompts?.map((prompt) => replaceScenarioTokens(prompt, replacements)),
		turns: scenario.turns.map((turn) => ({
			...turn,
			prompt: replaceScenarioTokens(turn.prompt, replacements),
		})),
	};
}

async function runNativeScenario(options: NativeRunOptions): Promise<EvalRunResult> {
	const subjectEntrypoint = await resolveSubjectEntrypoint(options.subjectEntrypoint);
	const runRoot = await mkdtemp(path.join(os.tmpdir(), "pi-rlm-eval-native-"));
	const sessionAgentDir = path.join(runRoot, "agent");
	const spyLogPath = path.join(runRoot, "pi-spy.jsonl");
	await mkdir(sessionAgentDir, { recursive: true });

	const scenario = await materializeScenarioForRun(options.scenario, runRoot);
	const effectiveAuthAgentDir = options.isolatedAuth ? sessionAgentDir : options.authAgentDir;
	await mkdir(effectiveAuthAgentDir, { recursive: true });
	const fileAuthStorage = AuthStorage.create(path.join(effectiveAuthAgentDir, "auth.json"));
	const authStorage = AuthStorage.inMemory(fileAuthStorage.getAll());
	const modelRegistry = ModelRegistry.create(authStorage, path.join(effectiveAuthAgentDir, "models.json"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

	const selectedModel = resolveNativeModel(modelRegistry, options, authStorage);
	if (!selectedModel) {
		throw new Error(
			`Could not resolve model ${options.modelId}. Try --model-provider <provider>. Available matching providers: ${findMatchingProviders(modelRegistry, options.modelId).join(", ") || "(none)"}`,
		);
	}
	if (options.authProviderOverride && options.authProviderOverride !== selectedModel.provider) {
		const overrideCredential = authStorage.get(options.authProviderOverride);
		if (overrideCredential) {
			authStorage.set(selectedModel.provider, overrideCredential);
		}
	}
	if (options.reasoning && selectedModel.reasoning === false) {
		// keep going, but make it visible in logs later via selected model metadata
	}
	if (options.apiKeySource) {
		authStorage.setRuntimeApiKey(selectedModel.provider, resolveConfigValueLikePi(options.apiKeySource));
	}

	const resolvedSubjectEntrypoint = path.resolve(subjectEntrypoint);
	const resolvedSpyEntrypoint = path.resolve(options.spyEntrypoint);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.scenario.cwd,
		agentDir: sessionAgentDir,
		settingsManager,
		additionalExtensionPaths: [resolvedSubjectEntrypoint, resolvedSpyEntrypoint],
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter(
				(extension) =>
					extension.resolvedPath === resolvedSubjectEntrypoint || extension.resolvedPath === resolvedSpyEntrypoint,
			),
		}),
	});

	const previousSpyAuto = process.env.PI_SPY_AUTO;
	const previousSpyLog = process.env.PI_SPY_LOG;
	process.env.PI_SPY_AUTO = "true";
	process.env.PI_SPY_LOG = spyLogPath;

	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd: options.scenario.cwd,
			model: selectedModel,
			authStorage,
			modelRegistry,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(options.scenario.cwd),
		});
		session = created.session;
		for (const [flagName, flagValue] of Object.entries(options.scenario.extensionFlags ?? {})) {
			session.extensionRunner?.setFlagValue(flagName, flagValue);
		}
		await session.bindExtensions({});

		const turns: EvalTurnResult[] = [];
		let currentTools: EvalToolEvent[] = [];
		let currentReadPaths: string[] = [];
		let currentAssistantDeltas = "";
		let currentRlmExecCount = 0;
		let currentChildQueryCount = 0;
		let currentChildTurns = 0;
		let currentSimpleQueryCount = 0;
		let currentSimpleBatchCount = 0;
		let currentRecursiveQueryCount = 0;
		let currentRecursiveBatchCount = 0;
		let currentSubmodelOverrideCount = 0;
		let currentSubmodelOverrides: EvalSubmodelOverride[] = [];
		let currentShowVarsCount = 0;
		let currentFinalAliasUsed = false;
		let currentFinalVarAliasUsed = false;
		let currentAssistantUsage: ProxyUsage = emptyUsage();
		let currentAssistantStopReason: string | undefined;
		let currentAssistantErrorMessage: string | undefined;

		unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				currentTools.push({ phase: "start", toolName: event.toolName, args: event.args });
				if (event.toolName === "read") {
					const maybePath = (event.args as { path?: unknown } | undefined)?.path;
					if (typeof maybePath === "string") currentReadPaths.push(maybePath);
				}
			}
			if (event.type === "tool_execution_end") {
				currentTools.push({
					phase: "end",
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				});
				if (event.toolName === "rlm_exec") {
					currentRlmExecCount += 1;
					const details = (event.result as { details?: Record<string, unknown> } | undefined)?.details;
					currentChildQueryCount += typeof details?.childQueryCount === "number" ? details.childQueryCount : 0;
					currentChildTurns += typeof details?.childTurns === "number" ? details.childTurns : 0;
					currentSimpleQueryCount += typeof details?.simpleQueryCount === "number" ? details.simpleQueryCount : 0;
					currentSimpleBatchCount += typeof details?.simpleBatchCount === "number" ? details.simpleBatchCount : 0;
					currentRecursiveQueryCount += typeof details?.recursiveQueryCount === "number" ? details.recursiveQueryCount : 0;
					currentRecursiveBatchCount += typeof details?.recursiveBatchCount === "number" ? details.recursiveBatchCount : 0;
					currentSubmodelOverrideCount += typeof details?.submodelOverrideCount === "number" ? details.submodelOverrideCount : 0;
					currentShowVarsCount += typeof details?.showVarsCount === "number" ? details.showVarsCount : 0;
					currentFinalAliasUsed = currentFinalAliasUsed || details?.finalAliasUsed === true;
					currentFinalVarAliasUsed = currentFinalVarAliasUsed || details?.finalVarAliasUsed === true;
					currentSubmodelOverrides.push(...extractSubmodelOverrides(details?.submodelOverrides));
				}
			}
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				currentAssistantDeltas += event.assistantMessageEvent.delta;
			}
			if (event.type === "turn_end") {
				currentAssistantUsage = usageFromAssistantMessage(event.message);
				currentAssistantStopReason = extractField(event.message, "stopReason");
				currentAssistantErrorMessage = extractField(event.message, "errorMessage");
			}
		});

		let previousFirstCanonical = "";
		let previousMessageCount = session.messages.length;
		let spyCursor = 0;

		for (const setupPrompt of scenario.setupPrompts ?? []) {
			await session.prompt(setupPrompt);
			previousMessageCount = session.messages.length;
			spyCursor = (await readSpyEvents(spyLogPath)).length;
		}

		for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
			const turn = scenario.turns[turnIndex];
			currentTools = [];
			currentReadPaths = [];
			currentAssistantDeltas = "";
			currentRlmExecCount = 0;
			currentChildQueryCount = 0;
			currentChildTurns = 0;
			currentSimpleQueryCount = 0;
			currentSimpleBatchCount = 0;
			currentRecursiveQueryCount = 0;
			currentRecursiveBatchCount = 0;
			currentSubmodelOverrideCount = 0;
			currentSubmodelOverrides = [];
			currentShowVarsCount = 0;
			currentFinalAliasUsed = false;
			currentFinalVarAliasUsed = false;
			currentAssistantUsage = emptyUsage();
			currentAssistantStopReason = undefined;
			currentAssistantErrorMessage = undefined;

			const startedAt = performance.now();
			await session.prompt(turn.prompt);
			const durationMs = performance.now() - startedAt;

			const allSpyEvents = await readSpyEvents(spyLogPath);
			const newSpyEvents = allSpyEvents.slice(spyCursor);
			spyCursor = allSpyEvents.length;
			const requests = spyEventsToRequests(newSpyEvents, turnIndex, turn.id);
			const contextSamples = spyEventsToContextSamples(newSpyEvents);
			const contextStats = summarizeContextSamples(contextSamples);
			const workspaceStats = spyEventsToWorkspaceStats(newSpyEvents);
			const newMessages = session.messages.slice(previousMessageCount);
			previousMessageCount = session.messages.length;
			const assistantText = extractAssistantText(newMessages, currentAssistantDeltas);
			const firstRequestCanonical = requests[0]
				? canonicalizeProviderPayload(requests[0].requestBodyJson ?? requests[0].requestBodyText)
				: "";
			const sharedPrefix = previousFirstCanonical && firstRequestCanonical
				? longestCommonPrefixChars(previousFirstCanonical, firstRequestCanonical)
				: undefined;
			const repeatedReadPaths = findRepeated(currentReadPaths);
			const repeatedReadRatio = computeRepeatedReadRatio(currentReadPaths);
			const leafToolCount = currentTools.filter((tool) => tool.phase === "start" && !isRlmInternalTool(tool.toolName)).length;
			const commitTruthfulness = analyzeCommitTruthfulness(assistantText, workspaceStats.commitCount);
			const pathCitations = analyzeAssistantPathCitations(assistantText, getRepoRoot());
			turns.push({
				turnIndex,
				turnId: turn.id,
				title: turn.title,
				prompt: turn.prompt,
				durationMs,
				assistantText,
				assistantStopReason: currentAssistantStopReason,
				assistantErrorMessage: currentAssistantErrorMessage,
				requestCount: requests.length,
				requests,
				usage: currentAssistantUsage,
				tools: currentTools,
				readPaths: currentReadPaths,
				repeatedReadPaths,
				...(repeatedReadRatio !== undefined ? { repeatedReadRatio } : {}),
				leafToolCount,
				rlmExecCount: currentRlmExecCount,
				childQueryCount: currentChildQueryCount,
				childTurns: currentChildTurns,
				attemptedSimpleQueryCount: sumRlmExecNumber(currentTools, "attemptedSimpleQueryCount"),
				attemptedSimpleBatchCount: sumRlmExecNumber(currentTools, "attemptedSimpleBatchCount"),
				attemptedRecursiveQueryCount: sumRlmExecNumber(currentTools, "attemptedRecursiveQueryCount"),
				attemptedRecursiveBatchCount: sumRlmExecNumber(currentTools, "attemptedRecursiveBatchCount"),
				simpleQueryCount: currentSimpleQueryCount,
				simpleBatchCount: currentSimpleBatchCount,
				recursiveQueryCount: currentRecursiveQueryCount,
				recursiveBatchCount: currentRecursiveBatchCount,
				submodelOverrideCount: currentSubmodelOverrideCount,
				submodelOverrides: dedupeSubmodelOverrides(currentSubmodelOverrides),
				showVarsCount: currentShowVarsCount,
				finalAliasUsed: currentFinalAliasUsed,
				finalVarAliasUsed: currentFinalVarAliasUsed,
				commitCount: workspaceStats.commitCount,
				workspaceCommits: workspaceStats.workspaceCommits,
				committedAfterLeafTools: workspaceStats.committedAfterLeafTools,
				committedBeforeLeafTools: workspaceStats.committedBeforeLeafTools,
				commitTruthfulness,
				pathCitations,
				workspaceState: workspaceStats.workspaceState,
				workspacePendingConsolidation: workspaceStats.workspaceState?.pendingConsolidation,
				workspaceHasCommitted: workspaceStats.workspaceState?.hasCommitted,
				runtimeBindingCountBefore: sumRlmExecNumber(currentTools, "runtimeBindingCountBefore"),
				runtimeBindingCountAfter: sumRlmExecNumber(currentTools, "runtimeBindingCountAfter"),
				runtimeNewBindingCount: sumRlmExecNumber(currentTools, "runtimeNewBindingCount"),
				runtimeUpdatedBindingCount: sumRlmExecNumber(currentTools, "runtimeUpdatedBindingCount"),
				firstRequestCanonical,
				context: contextStats,
				...(sharedPrefix !== undefined
					? {
						firstRequestSharedPrefixCharsVsPreviousTurn: sharedPrefix,
						firstRequestSharedPrefixRatioVsPreviousTurn: safeRatio(sharedPrefix, Math.max(previousFirstCanonical.length, 1)),
					}
					: {}),
			});
			previousFirstCanonical = firstRequestCanonical;
		}

		const summary = {
			totalDurationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
			totalRequests: turns.reduce((sum, turn) => sum + turn.requestCount, 0),
			promptTokens: turns.reduce((sum, turn) => sum + turn.usage.promptTokens, 0),
			completionTokens: turns.reduce((sum, turn) => sum + turn.usage.completionTokens, 0),
			totalTokens: turns.reduce((sum, turn) => sum + turn.usage.totalTokens, 0),
			cacheHitTokens: turns.reduce((sum, turn) => sum + turn.usage.cacheHitTokens, 0),
			cacheMissTokens: turns.reduce((sum, turn) => sum + turn.usage.cacheMissTokens, 0),
			totalToolCalls: turns.reduce((sum, turn) => sum + turn.tools.filter((tool) => tool.phase === "start").length, 0),
			totalRlmExecCount: turns.reduce((sum, turn) => sum + turn.rlmExecCount, 0),
			totalChildQueryCount: turns.reduce((sum, turn) => sum + turn.childQueryCount, 0),
			totalChildTurns: turns.reduce((sum, turn) => sum + turn.childTurns, 0),
			totalAttemptedSimpleQueryCount: turns.reduce((sum, turn) => sum + turn.attemptedSimpleQueryCount, 0),
			totalAttemptedSimpleBatchCount: turns.reduce((sum, turn) => sum + turn.attemptedSimpleBatchCount, 0),
			totalAttemptedRecursiveQueryCount: turns.reduce((sum, turn) => sum + turn.attemptedRecursiveQueryCount, 0),
			totalAttemptedRecursiveBatchCount: turns.reduce((sum, turn) => sum + turn.attemptedRecursiveBatchCount, 0),
			totalSimpleQueryCount: turns.reduce((sum, turn) => sum + turn.simpleQueryCount, 0),
			totalSimpleBatchCount: turns.reduce((sum, turn) => sum + turn.simpleBatchCount, 0),
			totalRecursiveQueryCount: turns.reduce((sum, turn) => sum + turn.recursiveQueryCount, 0),
			totalRecursiveBatchCount: turns.reduce((sum, turn) => sum + turn.recursiveBatchCount, 0),
			totalSubmodelOverrideCount: turns.reduce((sum, turn) => sum + turn.submodelOverrideCount, 0),
			totalShowVarsCount: turns.reduce((sum, turn) => sum + turn.showVarsCount, 0),
			turnsUsingFinalAlias: turns.filter((turn) => turn.finalAliasUsed).length,
			turnsUsingFinalVarAlias: turns.filter((turn) => turn.finalVarAliasUsed).length,
			totalWorkspaceCommits: turns.reduce((sum, turn) => sum + turn.commitCount, 0),
			turnsWithLeafTools: turns.filter((turn) => turn.leafToolCount > 0).length,
			turnsWithCommitAfterLeafTools: turns.filter((turn) => turn.leafToolCount > 0 && turn.committedAfterLeafTools).length,
			postLeafCommitRate: computePostLeafCommitRate(turns),
			claimedCommitTurns: turns.filter((turn) => turn.commitTruthfulness.claimedCommit).length,
			falseCommitClaimTurns: turns.filter((turn) => turn.commitTruthfulness.falseClaim).length,
			totalPathCitations: turns.reduce((sum, turn) => sum + turn.pathCitations.length, 0),
			existingPathCitations: turns.reduce((sum, turn) => sum + turn.pathCitations.filter((citation) => citation.exists).length, 0),
			missingPathCitations: turns.reduce((sum, turn) => sum + turn.pathCitations.filter((citation) => !citation.exists).length, 0),
			pathExistenceRate: computePathExistenceRate(turns),
			totalRuntimeNewBindingCount: turns.reduce((sum, turn) => sum + (turn.runtimeNewBindingCount ?? 0), 0),
			totalRuntimeUpdatedBindingCount: turns.reduce((sum, turn) => sum + (turn.runtimeUpdatedBindingCount ?? 0), 0),
			totalReadPaths: turns.reduce((sum, turn) => sum + turn.readPaths.length, 0),
			totalRepeatedReadPaths: turns.reduce((sum, turn) => sum + turn.repeatedReadPaths.length, 0),
			repeatedReadRatio: computeAggregateRepeatedReadRatio(turns),
			turnsEndingPendingConsolidation: turns.filter((turn) => turn.workspacePendingConsolidation === true).length,
			staleRecoveryOpportunities: countStaleRecoveryOpportunities(turns),
			staleRecoveries: countStaleRecoveries(turns),
			staleRecoveryRate: computeStaleRecoveryRate(turns),
			plateauRatio: computePlateauRatio(turns),
			context: summarizeContextAcrossTurns(turns),
		};

		return {
			createdAt: new Date().toISOString(),
			harnessVersion: 1,
			piVersion: getPinnedPiVersion(),
			repoRoot: getRepoRoot(),
			scenario,
			subject: { label: options.subjectLabel, entrypoint: resolvedSubjectEntrypoint },
			model: {
				provider: selectedModel.provider,
				id: selectedModel.id,
				providerProfile: inferProviderProfileId(selectedModel, options.providerProfile.id),
				usageFormat: selectedModel.api,
				upstreamBaseUrl: selectedModel.baseUrl,
				proxyBaseUrl: "",
				transportMode: "native",
				authAgentDir: effectiveAuthAgentDir,
				isolatedAuth: options.isolatedAuth,
				cacheFieldMapping: {
					promptTokens: "assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite",
					completionTokens: "assistant.usage.output",
					totalTokens: "assistant.usage.totalTokens",
					cacheHitTokens: "assistant.usage.cacheRead",
					cacheMissTokens: "promptTokens - cacheHitTokens",
				},
			},
			turns,
			summary,
		};
	} finally {
		try {
			await session?.extensionRunner?.emit({ type: "session_shutdown" });
		} catch {
			// ignore shutdown errors
		}
		unsubscribe?.();
		session?.dispose();
		if (previousSpyAuto === undefined) delete process.env.PI_SPY_AUTO;
		else process.env.PI_SPY_AUTO = previousSpyAuto;
		if (previousSpyLog === undefined) delete process.env.PI_SPY_LOG;
		else process.env.PI_SPY_LOG = previousSpyLog;
		await rm(runRoot, { recursive: true, force: true });
	}
}

function resolveNativeModel(modelRegistry: ModelRegistry, options: NativeRunOptions, authStorage: AuthStorage) {
	if (options.modelProviderOverride) {
		return modelRegistry.find(options.modelProviderOverride, options.modelId);
	}
	if (options.authProviderOverride) {
		const exact = modelRegistry.find(options.authProviderOverride, options.modelId);
		if (exact) return exact;
		const authAliasExists = authStorage.has(options.authProviderOverride);
		if (!authAliasExists) {
			const available = findMatchingProviders(modelRegistry, options.modelId);
			throw new Error(
				`Auth provider override ${options.authProviderOverride} is neither a registered provider for model ${options.modelId} nor an available auth alias. Available matching providers: ${available.join(", ") || "(none)"}. Available auth aliases: ${authStorage.list().join(", ") || "(none)"}`,
			);
		}
	}
	for (const provider of options.providerProfile.authProviderCandidates ?? [options.providerProfile.providerName]) {
		const exact = modelRegistry.find(provider, options.modelId);
		if (exact) return exact;
	}
	const matches = modelRegistry.getAll().filter((model) => model.id === options.modelId);
	if (matches.length === 1) return matches[0];
	const authed = matches.filter((model) => authStorage.hasAuth(model.provider));
	if (authed.length === 1) return authed[0];
	return undefined;
}

function findMatchingProviders(modelRegistry: ModelRegistry, modelId: string): string[] {
	return Array.from(new Set(modelRegistry.getAll().filter((model) => model.id === modelId).map((model) => model.provider))).sort();
}

function inferProviderProfileId(
	model: { provider: string; api?: string; baseUrl?: string },
	fallback: EvalRunResult["model"]["providerProfile"],
): EvalRunResult["model"]["providerProfile"] {
	if (model.provider === "eval-mlx") return "mlx";
	if (typeof model.api === "string" && model.api.includes("responses")) return "openai-responses";
	if (typeof model.api === "string" && model.api.includes("completions")) return "openai-chat";
	if (model.provider.startsWith("openai")) return "openai-chat";
	if (typeof model.baseUrl === "string" && model.baseUrl.includes("chatgpt.com/backend-api")) return "openai-responses";
	return fallback;
}

function resolveConfigValueLikePi(config: string): string {
	return process.env[config] || config;
}

async function readSpyEvents(logPath: string): Promise<SpyEvent[]> {
	try {
		const text = await readFile(logPath, "utf8");
		return text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SpyEvent);
	} catch {
		return [];
	}
}

function spyEventsToRequests(events: SpyEvent[], turnIndex: number, turnId: string): ProxyLogEntry[] {
	return events
		.filter((event) => event.type === "before_provider_request")
		.map((event, index) => {
			const payload = isRecord(event.data) ? event.data.payload : undefined;
			return {
				requestId: `${turnId}-${index}`,
				method: "PROVIDER",
				requestBodyText: payload ? JSON.stringify(payload) : "",
				requestBodyJson: payload,
				startedAt: event.timestamp,
				durationMs: 0,
				turnIndex,
				turnId,
			};
		});
}

function spyEventsToContextSamples(events: SpyEvent[]): SpyContextSample[] {
	return events
		.filter((event) => event.type === "context")
		.map((event) => {
			const data = isRecord(event.data) ? event.data : {};
			return {
				messageCount: optionalNumber(data.messageCount),
				estimatedChars: optionalNumber(data.estimatedChars),
			};
		});
}

function isRlmInternalTool(toolName: string): boolean {
	return toolName === "rlm_exec" || toolName === "rlm_inspect" || toolName === "rlm_reset";
}

function spyEventsToWorkspaceStats(events: SpyEvent[]): TurnWorkspaceStats {
	let lastLeafToolIndex = -1;
	let firstLeafToolIndex = -1;
	let commitCount = 0;
	let committedAfterLeafTools = false;
	let committedBeforeLeafTools = false;
	let workspaceState: EvalTurnResult["workspaceState"] | undefined;
	const workspaceCommits: EvalTurnResult["workspaceCommits"] = [];

	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (event.type === "tool_execution_end") {
			const data = isRecord(event.data) ? event.data : {};
			const toolName = typeof data.toolName === "string" ? data.toolName : "";
			if (toolName && !isRlmInternalTool(toolName)) {
				lastLeafToolIndex = index;
				if (firstLeafToolIndex === -1) firstLeafToolIndex = index;
			}
			continue;
		}
		if (event.type === "workspace_commit") {
			const data = isRecord(event.data) ? event.data : {};
			const commit = {
				changedKeys: Array.isArray(data.changedKeys) ? data.changedKeys.filter((item): item is string => typeof item === "string") : [],
				ignoredKeys: Array.isArray(data.ignoredKeys) ? data.ignoredKeys.filter((item): item is string => typeof item === "string") : [],
				planLength: optionalNumber(data.planLength) ?? 0,
				findingCount: optionalNumber(data.findingCount) ?? 0,
				pendingConsolidation: data.pendingConsolidation === true,
				activeContextSummaryPresent: data.activeContextSummaryPresent === true,
			};
			workspaceCommits.push(commit);
			commitCount += 1;
			if (lastLeafToolIndex !== -1 && index > lastLeafToolIndex) committedAfterLeafTools = true;
			if (firstLeafToolIndex === -1 || index < firstLeafToolIndex) committedBeforeLeafTools = true;
			continue;
		}
		if (event.type === "workspace_state") {
			const data = isRecord(event.data) ? event.data : {};
			workspaceState = {
				hasCommitted: data.hasCommitted === true,
				pendingConsolidation: data.pendingConsolidation === true,
				lastCommittedTurn: optionalNumber(data.lastCommittedTurn),
				lastLeafToolTurn: optionalNumber(data.lastLeafToolTurn),
				lastCommitChangedKeys: Array.isArray(data.lastCommitChangedKeys)
					? data.lastCommitChangedKeys.filter((item): item is string => typeof item === "string")
					: undefined,
				planLength: optionalNumber(data.planLength) ?? 0,
				findingCount: optionalNumber(data.findingCount) ?? 0,
				artifactCount: optionalNumber(data.artifactCount) ?? 0,
				activeContextSummary: typeof data.activeContextSummary === "string" ? data.activeContextSummary : undefined,
			};
		}
	}

	return {
		commitCount,
		workspaceCommits,
		committedAfterLeafTools,
		committedBeforeLeafTools,
		workspaceState,
	};
}

function sumRlmExecNumber(tools: EvalToolEvent[], key: string): number {
	return tools.reduce((sum, tool) => {
		if (tool.phase !== "end" || tool.toolName !== "rlm_exec") return sum;
		const details = isRecord((tool.result as { details?: unknown } | undefined)?.details)
			? ((tool.result as { details?: Record<string, unknown> }).details as Record<string, unknown>)
			: undefined;
		const value = details && typeof details[key] === "number" && Number.isFinite(details[key]) ? (details[key] as number) : 0;
		return sum + value;
	}, 0);
}

function extractSubmodelOverrides(value: unknown): EvalSubmodelOverride[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item)) return [];
		const kind = item.kind === "simple" || item.kind === "recursive" ? item.kind : undefined;
		const requested = typeof item.requested === "string" ? item.requested : undefined;
		const resolvedProvider = typeof item.resolvedProvider === "string" ? item.resolvedProvider : undefined;
		const resolvedId = typeof item.resolvedId === "string" ? item.resolvedId : undefined;
		if (!kind || !requested || !resolvedProvider || !resolvedId) return [];
		return [{
			kind,
			requested,
			resolvedProvider,
			resolvedId,
			...(typeof item.thinkingLevel === "string" ? { thinkingLevel: item.thinkingLevel } : {}),
		}];
	});
}

function dedupeSubmodelOverrides(overrides: EvalSubmodelOverride[]): EvalSubmodelOverride[] {
	const seen = new Set<string>();
	const next: EvalSubmodelOverride[] = [];
	for (const override of overrides) {
		const key = `${override.kind}:${override.requested}:${override.resolvedProvider}:${override.resolvedId}:${override.thinkingLevel ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		next.push(override);
	}
	return next;
}

function summarizeContextSamples(samples: SpyContextSample[]): EvalContextStats | undefined {
	if (samples.length === 0) return undefined;
	const messageCounts = samples.map((sample) => sample.messageCount).filter(isFiniteNumber);
	const estimatedChars = samples.map((sample) => sample.estimatedChars).filter(isFiniteNumber);
	const last = samples[samples.length - 1];
	return {
		eventCount: samples.length,
		lastMessageCount: last?.messageCount,
		lastEstimatedChars: last?.estimatedChars,
		maxMessageCount: messageCounts.length ? Math.max(...messageCounts) : undefined,
		maxEstimatedChars: estimatedChars.length ? Math.max(...estimatedChars) : undefined,
	};
}

function summarizeContextAcrossTurns(turns: EvalTurnResult[]): EvalRunResult["summary"]["context"] | undefined {
	const contexts = turns.map((turn) => turn.context).filter((context): context is EvalContextStats => !!context);
	if (contexts.length === 0) return undefined;
	const last = contexts.at(-1);
	return {
		maxMessageCount: maxOf(contexts.map((context) => context.maxMessageCount)),
		maxEstimatedChars: maxOf(contexts.map((context) => context.maxEstimatedChars)),
		lastMessageCount: last?.lastMessageCount ?? last?.maxMessageCount,
		lastEstimatedChars: last?.lastEstimatedChars ?? last?.maxEstimatedChars,
	};
}

function computePostLeafCommitRate(turns: EvalTurnResult[]): number | undefined {
	const eligible = turns.filter((turn) => turn.leafToolCount > 0);
	if (eligible.length === 0) return undefined;
	return eligible.filter((turn) => turn.committedAfterLeafTools).length / eligible.length;
}

function computePathExistenceRate(turns: EvalTurnResult[]): number | undefined {
	const citations = turns.flatMap((turn) => turn.pathCitations);
	if (citations.length === 0) return undefined;
	return citations.filter((citation) => citation.exists).length / citations.length;
}

function computeAggregateRepeatedReadRatio(turns: EvalTurnResult[]): number | undefined {
	const totalReadPaths = turns.reduce((sum, turn) => sum + turn.readPaths.length, 0);
	if (totalReadPaths === 0) return undefined;
	const repeatedReads = turns.reduce((sum, turn) => {
		const ratio = turn.repeatedReadRatio;
		if (ratio === undefined) return sum;
		return sum + (ratio * turn.readPaths.length);
	}, 0);
	return repeatedReads / totalReadPaths;
}

function countStaleRecoveryOpportunities(turns: EvalTurnResult[]): number {
	let opportunities = 0;
	for (let i = 0; i < turns.length - 1; i += 1) {
		if (turns[i].workspacePendingConsolidation === true) opportunities += 1;
	}
	return opportunities;
}

function countStaleRecoveries(turns: EvalTurnResult[]): number {
	let recoveries = 0;
	for (let i = 0; i < turns.length - 1; i += 1) {
		if (turns[i].workspacePendingConsolidation !== true) continue;
		const nextTurn = turns[i + 1];
		if (nextTurn.commitCount > 0 && nextTurn.committedBeforeLeafTools) recoveries += 1;
	}
	return recoveries;
}

function computeStaleRecoveryRate(turns: EvalTurnResult[]): number | undefined {
	const opportunities = countStaleRecoveryOpportunities(turns);
	if (opportunities === 0) return undefined;
	return countStaleRecoveries(turns) / opportunities;
}

function computePlateauRatio(turns: EvalTurnResult[]): number | undefined {
	if (turns.length < 10) return undefined;
	const lateTurns = turns.slice(10, 20);
	const midTurns = turns.slice(4, 10);
	const lateMax = maxOf(lateTurns.map((turn) => turn.context?.maxEstimatedChars));
	const midMax = maxOf(midTurns.map((turn) => turn.context?.maxEstimatedChars));
	if (!lateMax || !midMax) return undefined;
	return lateMax / midMax;
}

function usageFromAssistantMessage(message: unknown): ProxyUsage {
	if (!isRecord(message) || !isRecord(message.usage)) return emptyUsage();
	const usage = message.usage as Record<string, unknown>;
	const output = numberValue(usage.output);
	const totalTokens = numberValue(usage.totalTokens);
	const cacheRead = numberValue(usage.cacheRead);
	const cacheWrite = numberValue(usage.cacheWrite);
	const input = numberValue(usage.input);
	const promptTokens = totalTokens > 0 ? Math.max(totalTokens - output, 0) : input + cacheRead + cacheWrite;
	return {
		promptTokens,
		completionTokens: output,
		totalTokens,
		cacheHitTokens: cacheRead,
		cacheMissTokens: Math.max(promptTokens - cacheRead, 0),
	};
}

function emptyUsage(): ProxyUsage {
	return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalNumber(value: unknown): number | undefined {
	return isFiniteNumber(value) ? value : undefined;
}

function maxOf(values: Array<number | undefined>): number | undefined {
	const filtered = values.filter(isFiniteNumber);
	return filtered.length ? Math.max(...filtered) : undefined;
}

function extractField(message: unknown, key: string): string | undefined {
	if (!isRecord(message)) return undefined;
	const value = message[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractAssistantText(messages: unknown[], fallback: string): string {
	const assistantTexts = messages
		.filter((message): message is { role: "assistant"; content: unknown } => {
			return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
		})
		.map((message) => {
			if (typeof message.content === "string") return message.content;
			if (!Array.isArray(message.content)) return "";
			return message.content
				.filter((block: unknown): block is { type: "text"; text: string } => {
					return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
				})
				.map((block) => block.text)
				.join("\n");
		})
		.filter((text) => text.trim().length > 0);
	return assistantTexts.at(-1) ?? fallback.trim();
}

function findRepeated(values: string[]): string[] {
	const seen = new Set<string>();
	const repeated = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) repeated.add(value);
		seen.add(value);
	}
	return Array.from(repeated).sort();
}

async function resolveSubjectEntrypoint(input: string): Promise<string> {
	const resolved = path.resolve(input);
	try {
		const stat = await import("node:fs/promises").then((fs) => fs.stat(resolved));
		if (stat.isDirectory()) {
			const candidate = path.join(resolved, "dist", "index.js");
			const candidateStat = await import("node:fs/promises").then((fs) => fs.stat(candidate));
			if (candidateStat.isFile()) return candidate;
		}
	} catch {
		// ignore
	}
	return resolved;
}

function resolveScenarios(input: string | boolean | undefined): EvalScenario[] {
	if (!input || input === "all") return getEvalScenarios();
	const scenario = findScenario(String(input));
	if (!scenario) throw new Error(`Unknown scenario: ${String(input)}`);
	return [scenario];
}

async function writeRunArtifacts(result: EvalRunResult, options: { outLabel: string }) {
	const hash = shortHash(`${result.subject.entrypoint}:${result.scenario.id}:${result.createdAt}`);
	const baseDir = path.join(getRepoRoot(), "eval", "results", `${timestampSlug(result.createdAt)}-${sanitize(options.outLabel)}-${result.scenario.id}-${hash}`);
	await mkdir(baseDir, { recursive: true });
	const jsonPath = path.join(baseDir, "result.json");
	const mdPath = path.join(baseDir, "summary.md");
	await writeFile(jsonPath, JSON.stringify(result, null, 2));
	await writeFile(mdPath, renderRunSummary(result, { baseDir, jsonPath, mdPath }));
	return { baseDir, jsonPath, mdPath };
}

async function writeCompareArtifacts(result: EvalCompareResult) {
	const hash = shortHash(`${result.baseline.subject.entrypoint}:${result.candidate.subject.entrypoint}:${result.createdAt}`);
	const baseDir = path.join(getRepoRoot(), "eval", "results", `${timestampSlug(result.createdAt)}-compare-${result.baseline.scenario.id}-${hash}`);
	await mkdir(baseDir, { recursive: true });
	const jsonPath = path.join(baseDir, "compare.json");
	const mdPath = path.join(baseDir, "compare.md");
	await writeFile(jsonPath, JSON.stringify(result, null, 2));
	await writeFile(mdPath, renderCompareSummary(result, { baseDir, jsonPath, mdPath }));
	return { baseDir, jsonPath, mdPath };
}

function renderRunSummary(result: EvalRunResult, out: { baseDir: string; jsonPath: string; mdPath: string }): string {
	const lines = [
		`# Eval run: ${result.subject.label} / ${result.scenario.id}`,
		"",
		`- Pi version: ${result.piVersion}`,
		`- Subject: ${result.subject.entrypoint}`,
		`- Scenario: ${result.scenario.label}`,
		`- Upstream: ${result.model.upstreamBaseUrl}`,
		`- Model: ${result.model.provider}/${result.model.id}`,
		`- Provider profile: ${result.model.providerProfile} (${result.model.usageFormat})`,
		`- Transport: ${result.model.transportMode}`,
		`- Auth agent dir: ${result.model.authAgentDir}${result.model.isolatedAuth ? " (isolated)" : " (shared Pi auth)"}`,
		`- Results dir: ${out.baseDir}`,
		`- JSON: ${out.jsonPath}`,
		"",
		"## Summary",
		"",
		`- Duration: ${formatMs(result.summary.totalDurationMs)}`,
		`- Requests: ${result.summary.totalRequests}`,
		`- Prompt tokens: ${result.summary.promptTokens}`,
		`- Completion tokens: ${result.summary.completionTokens}`,
		`- Cache hit tokens: ${result.summary.cacheHitTokens}`,
		`- Cache miss tokens: ${result.summary.cacheMissTokens}`,
		`- Tool calls: ${result.summary.totalToolCalls}`,
		`- rlm_exec count: ${result.summary.totalRlmExecCount}`,
		`- Child queries/turns: ${result.summary.totalChildQueryCount}/${result.summary.totalChildTurns}`,
		`- Attempted simple queries/batches: ${result.summary.totalAttemptedSimpleQueryCount}/${result.summary.totalAttemptedSimpleBatchCount}`,
		`- Attempted recursive queries/batches: ${result.summary.totalAttemptedRecursiveQueryCount}/${result.summary.totalAttemptedRecursiveBatchCount}`,
		`- Executed simple queries/batches: ${result.summary.totalSimpleQueryCount}/${result.summary.totalSimpleBatchCount}`,
		`- Executed recursive queries/batches: ${result.summary.totalRecursiveQueryCount}/${result.summary.totalRecursiveBatchCount}`,
		`- Submodel overrides: ${result.summary.totalSubmodelOverrideCount}`,
		`- SHOW_VARS count: ${result.summary.totalShowVarsCount}`,
		`- FINAL / FINAL_VAR turns: ${result.summary.turnsUsingFinalAlias} / ${result.summary.turnsUsingFinalVarAlias}`,
		`- Workspace commits: ${result.summary.totalWorkspaceCommits}`,
		`- Claimed commit turns: ${result.summary.claimedCommitTurns}`,
		`- False commit-claim turns: ${result.summary.falseCommitClaimTurns}`,
		`- Path citations: ${result.summary.totalPathCitations}`,
		`- Missing path citations: ${result.summary.missingPathCitations}`,
		`- Runtime new bindings: ${result.summary.totalRuntimeNewBindingCount}`,
		`- Runtime updated bindings: ${result.summary.totalRuntimeUpdatedBindingCount}`,
	];
	if (result.summary.pathExistenceRate !== undefined) lines.push(`- Path existence rate: ${(100 * result.summary.pathExistenceRate).toFixed(1)}%`);
	if (result.summary.repeatedReadRatio !== undefined) lines.push(`- Repeated read ratio: ${(100 * result.summary.repeatedReadRatio).toFixed(1)}%`);
	if (result.summary.postLeafCommitRate !== undefined) lines.push(`- Post-leaf commit rate: ${(100 * result.summary.postLeafCommitRate).toFixed(1)}%`);
	if (result.summary.staleRecoveryRate !== undefined) lines.push(`- Stale recovery rate: ${(100 * result.summary.staleRecoveryRate).toFixed(1)}%`);
	if (result.summary.plateauRatio !== undefined) lines.push(`- Plateau ratio: ${result.summary.plateauRatio.toFixed(2)}`);
	if (result.summary.context) {
		lines.push(
			`- Context (max): messages ${formatMaybeNumber(result.summary.context.maxMessageCount)}, est chars ${formatMaybeNumber(result.summary.context.maxEstimatedChars)}`,
			`- Context (last): messages ${formatMaybeNumber(result.summary.context.lastMessageCount)}, est chars ${formatMaybeNumber(result.summary.context.lastEstimatedChars)}`,
		);
	}
	lines.push(
		"",
		"## Turns",
		"",
	);
	for (const turn of result.turns) {
		lines.push(`### ${turn.turnIndex + 1}. ${turn.title}`);
		lines.push(`- Requests: ${turn.requestCount}`);
		lines.push(`- Duration: ${formatMs(turn.durationMs)}`);
		lines.push(`- Usage: prompt ${turn.usage.promptTokens}, completion ${turn.usage.completionTokens}, cache hit ${turn.usage.cacheHitTokens}, cache miss ${turn.usage.cacheMissTokens}`);
		if (turn.context) {
			lines.push(`- Context: ${formatContextStats(turn.context)}`);
		}
		if (turn.firstRequestCanonical) {
			lines.push(`- First request canonical: ${turn.firstRequestCanonical.length} chars, hash ${shortHash(turn.firstRequestCanonical)}`);
		}
		lines.push(`- Tools: ${turn.tools.filter((tool) => tool.phase === "start").length}, leaf ${turn.leafToolCount}, rlm_exec ${turn.rlmExecCount}, child ${turn.childQueryCount}/${turn.childTurns}, simple attempted/executed ${turn.attemptedSimpleQueryCount}/${turn.simpleQueryCount}, simple batches attempted/executed ${turn.attemptedSimpleBatchCount}/${turn.simpleBatchCount}, recursive attempted/executed ${turn.attemptedRecursiveQueryCount}/${turn.recursiveQueryCount}, recursive batches attempted/executed ${turn.attemptedRecursiveBatchCount}/${turn.recursiveBatchCount}, commits ${turn.commitCount}`);
		if (turn.submodelOverrideCount > 0) {
			lines.push(`- Submodel overrides: ${turn.submodelOverrides.map((override) => `${override.kind}:${override.requested}->${override.resolvedProvider}/${override.resolvedId}${override.thinkingLevel ? `:${override.thinkingLevel}` : ""}`).join(", ")}`);
		}
		if (turn.showVarsCount > 0 || turn.finalAliasUsed || turn.finalVarAliasUsed) {
			lines.push(`- Runtime helper usage: SHOW_VARS ${turn.showVarsCount}, FINAL ${turn.finalAliasUsed ? "yes" : "no"}, FINAL_VAR ${turn.finalVarAliasUsed ? "yes" : "no"}`);
		}
		if (turn.leafToolCount > 0) lines.push(`- Post-leaf commit: ${turn.committedAfterLeafTools ? "yes" : "no"}`);
		if (turn.commitTruthfulness.claimedCommit) {
			lines.push(`- Commit claim: claimed=yes actual=${turn.commitTruthfulness.actualCommit ? "yes" : "no"}${turn.commitTruthfulness.falseClaim ? " (false claim)" : ""}`);
		}
		if (turn.pathCitations.length > 0) {
			const missing = turn.pathCitations.filter((citation) => !citation.exists).map((citation) => citation.cited);
			lines.push(`- Path citations: ${turn.pathCitations.length} total, ${missing.length} missing`);
			if (missing.length > 0) lines.push(`- Missing cited paths: ${missing.join(", ")}`);
		}
		if (turn.workspaceState) lines.push(`- Workspace: committed=${turn.workspaceState.hasCommitted} pending=${turn.workspaceState.pendingConsolidation} plan=${turn.workspaceState.planLength} findings=${turn.workspaceState.findingCount} artifacts=${turn.workspaceState.artifactCount}`);
		if (turn.runtimeBindingCountBefore !== undefined || turn.runtimeBindingCountAfter !== undefined) {
			lines.push(`- Runtime bindings: before ${formatMaybeNumber(turn.runtimeBindingCountBefore)}, after ${formatMaybeNumber(turn.runtimeBindingCountAfter)}, new ${formatMaybeNumber(turn.runtimeNewBindingCount)}, updated ${formatMaybeNumber(turn.runtimeUpdatedBindingCount)}`);
		}
		if (turn.assistantStopReason) lines.push(`- Assistant stop reason: ${turn.assistantStopReason}`);
		if (turn.assistantErrorMessage) lines.push(`- Assistant error: ${turn.assistantErrorMessage}`);
		if (turn.firstRequestSharedPrefixCharsVsPreviousTurn !== undefined) {
			lines.push(`- First request shared prefix vs previous turn: ${turn.firstRequestSharedPrefixCharsVsPreviousTurn} chars (${(100 * (turn.firstRequestSharedPrefixRatioVsPreviousTurn ?? 0)).toFixed(1)}%)`);
		}
		if (turn.repeatedReadRatio !== undefined) lines.push(`- Repeated read ratio: ${(100 * turn.repeatedReadRatio).toFixed(1)}%`);
		if (turn.repeatedReadPaths.length > 0) lines.push(`- Repeated read paths: ${turn.repeatedReadPaths.join(", ")}`);
		lines.push("- Assistant output preview:");
		lines.push("```text");
		lines.push(trimPreview(turn.assistantText));
		lines.push("```");
		lines.push("");
	}
	return lines.join("\n");
}

function renderCompareSummary(result: EvalCompareResult, out: { baseDir: string; jsonPath: string; mdPath: string }): string {
	const lines = [
		`# Eval compare: ${result.baseline.scenario.id}`,
		"",
		`- Results dir: ${out.baseDir}`,
		`- JSON: ${out.jsonPath}`,
		"",
		"## Subjects",
		"",
		`- Baseline: ${result.baseline.subject.entrypoint}`,
		`- Candidate: ${result.candidate.subject.entrypoint}`,
		`- Provider profile: ${result.baseline.model.providerProfile}`,
		`- Transport: ${result.baseline.model.transportMode}`,
		`- Auth agent dir: ${result.baseline.model.authAgentDir}${result.baseline.model.isolatedAuth ? " (isolated)" : " (shared Pi auth)"}`,
		"",
		"## Delta (candidate - baseline)",
		"",
		`- Duration: ${signed(result.delta.durationMs)} ms`,
		`- Prompt tokens: ${signed(result.delta.promptTokens)}`,
		`- Completion tokens: ${signed(result.delta.completionTokens)}`,
		`- Total tokens: ${signed(result.delta.totalTokens)}`,
		`- Cache hit tokens: ${signed(result.delta.cacheHitTokens)}`,
		`- Cache miss tokens: ${signed(result.delta.cacheMissTokens)}`,
		`- Tool calls: ${signed(result.delta.toolCalls)}`,
		`- rlm_exec count: ${signed(result.delta.rlmExecCount)}`,
		`- Child queries: ${signed(result.delta.childQueryCount)}`,
		`- Child turns: ${signed(result.delta.childTurns)}`,
		`- Attempted simple queries: ${signed(result.delta.attemptedSimpleQueryCount)}`,
		`- Attempted simple batches: ${signed(result.delta.attemptedSimpleBatchCount)}`,
		`- Attempted recursive queries: ${signed(result.delta.attemptedRecursiveQueryCount)}`,
		`- Attempted recursive batches: ${signed(result.delta.attemptedRecursiveBatchCount)}`,
		`- Simple queries: ${signed(result.delta.simpleQueryCount)}`,
		`- Simple batches: ${signed(result.delta.simpleBatchCount)}`,
		`- Recursive queries: ${signed(result.delta.recursiveQueryCount)}`,
		`- Recursive batches: ${signed(result.delta.recursiveBatchCount)}`,
		`- Submodel overrides: ${signed(result.delta.submodelOverrideCount)}`,
		`- SHOW_VARS count: ${signed(result.delta.showVarsCount)}`,
		`- Workspace commits: ${signed(result.delta.workspaceCommits)}`,
		`- False commit-claim turns: ${signed(result.delta.falseCommitClaimTurns)}`,
		`- Missing path citations: ${signed(result.delta.missingPathCitations)}`,
		`- Path existence rate: ${signed(result.delta.pathExistenceRate * 100)} pp`,
		`- Runtime new bindings: ${signed(result.delta.runtimeNewBindingCount)}`,
		`- Runtime updated bindings: ${signed(result.delta.runtimeUpdatedBindingCount)}`,
		`- Repeated read ratio: ${signed(result.delta.repeatedReadRatio * 100)} pp`,
		`- Post-leaf commit rate: ${signed(result.delta.postLeafCommitRate * 100)} pp`,
		`- Stale recovery rate: ${signed(result.delta.staleRecoveryRate * 100)} pp`,
		`- Plateau ratio: ${signed(result.delta.plateauRatio)}`,
		"",
		"## Prefix drift evidence",
		"",
		...renderPrefixEvidence(result),
		"",
		"## Context size evidence",
		"",
		...renderContextEvidence(result),
		"",
		"## Baseline summary",
		"",
		renderRunSummary(result.baseline, { baseDir: out.baseDir, jsonPath: out.jsonPath, mdPath: out.mdPath }),
		"",
		"## Candidate summary",
		"",
		renderRunSummary(result.candidate, { baseDir: out.baseDir, jsonPath: out.jsonPath, mdPath: out.mdPath }),
	];
	return lines.join("\n");
}

function renderPrefixEvidence(result: EvalCompareResult): string[] {
	const lines: string[] = [];
	const turnCount = Math.max(result.baseline.turns.length, result.candidate.turns.length);
	for (let i = 0; i < turnCount; i += 1) {
		const baselineTurn = result.baseline.turns[i];
		const candidateTurn = result.candidate.turns[i];
		if (!baselineTurn && !candidateTurn) continue;
		lines.push(`### Turn ${i + 1}`);
		if (baselineTurn) lines.push(`- Baseline: ${describePrefixEvidence(baselineTurn)}`);
		if (candidateTurn) lines.push(`- Candidate: ${describePrefixEvidence(candidateTurn)}`);
		lines.push("");
	}
	if (lines.length === 0) lines.push("- No turn data available.");
	return lines;
}

function renderContextEvidence(result: EvalCompareResult): string[] {
	const lines: string[] = [];
	const turnCount = Math.max(result.baseline.turns.length, result.candidate.turns.length);
	for (let i = 0; i < turnCount; i += 1) {
		const baselineTurn = result.baseline.turns[i];
		const candidateTurn = result.candidate.turns[i];
		if (!baselineTurn && !candidateTurn) continue;
		lines.push(`### Turn ${i + 1}`);
		if (baselineTurn) lines.push(`- Baseline: ${describeContextEvidence(baselineTurn)}`);
		if (candidateTurn) lines.push(`- Candidate: ${describeContextEvidence(candidateTurn)}`);
		lines.push("");
	}
	if (lines.length === 0) lines.push("- No turn data available.");
	return lines;
}

function describePrefixEvidence(turn: EvalTurnResult): string {
	if (!turn.firstRequestCanonical) {
		return `no provider payload captured; usage prompt/cache=${turn.usage.promptTokens}/${turn.usage.cacheHitTokens}/${turn.usage.cacheMissTokens}`;
	}
	const prefix = turn.firstRequestSharedPrefixCharsVsPreviousTurn === undefined
		? "n/a vs previous"
		: `${turn.firstRequestSharedPrefixCharsVsPreviousTurn} chars (${(100 * (turn.firstRequestSharedPrefixRatioVsPreviousTurn ?? 0)).toFixed(1)}%) vs previous`;
	return `${turn.requestCount} request(s); first canonical ${turn.firstRequestCanonical.length} chars, hash ${shortHash(turn.firstRequestCanonical)}, shared prefix ${prefix}; usage prompt/cache=${turn.usage.promptTokens}/${turn.usage.cacheHitTokens}/${turn.usage.cacheMissTokens}`;
}

function describeContextEvidence(turn: EvalTurnResult): string {
	if (!turn.context) return "no context telemetry";
	const parts = [`events ${turn.context.eventCount}`];
	if (turn.context.maxMessageCount !== undefined) parts.push(`max messages ${turn.context.maxMessageCount}`);
	if (turn.context.maxEstimatedChars !== undefined) parts.push(`max chars ${turn.context.maxEstimatedChars}`);
	if (turn.context.lastMessageCount !== undefined || turn.context.lastEstimatedChars !== undefined) {
		parts.push(
			`last messages ${formatMaybeNumber(turn.context.lastMessageCount)}, last chars ${formatMaybeNumber(turn.context.lastEstimatedChars)}`,
		);
	}
	return parts.join("; ");
}

function parseArgs(args: string[]): CliArgs {
	const parsed: CliArgs = {};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
		const next = args[i + 1];
		if (!next || next.startsWith("--")) {
			parsed[key] = true;
			continue;
		}
		parsed[key] = next;
		i += 1;
	}
	return parsed;
}

function requireArg(args: CliArgs, key: string): string {
	const value = args[key];
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`Missing required --${key}`);
}

function resolveEvalAgentDir(options: { agentDir?: string }): string {
	return path.resolve(options.agentDir ?? getAgentDir());
}

function stringArg(args: CliArgs, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanArg(args: CliArgs, key: string): boolean | undefined {
	const value = args[key];
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	if (["true", "1", "yes"].includes(value)) return true;
	if (["false", "0", "no"].includes(value)) return false;
	return undefined;
}

function parseExtensionFlagValue(value: string): string | boolean {
	if (["true", "1", "yes"].includes(value)) return true;
	if (["false", "0", "no"].includes(value)) return false;
	return value;
}

function parseExtensionFlagsArg(value: string | undefined): Record<string, string | boolean> {
	if (!value) return {};
	const pairs = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	const flags: Record<string, string | boolean> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq === -1) {
			flags[pair] = true;
			continue;
		}
		const key = pair.slice(0, eq).trim();
		const rawValue = pair.slice(eq + 1).trim();
		if (!key) continue;
		flags[key] = parseExtensionFlagValue(rawValue);
	}
	return flags;
}

function rewriteRuntimeSurfacePromptForNoSubcalls(prompt: string): string {
	const marker = "\nStart in rlm_exec.";
	const index = prompt.indexOf(marker);
	if (index === -1) return prompt;
	const prefix = prompt.slice(0, index);
	return `${prefix}\nStart in rlm_exec in no-subcalls mode. Inspect globalThis.context and any needed runtime views, run leaf tool actions directly, keep durable findings in globalThis.workspace via workspace.commit({...}), and finalize from runtime state. Avoid child-query helpers (llm_query, rlm_query, llm_query_batched, rlm_query_batched).`;
}

function withScenarioExtensionFlags(
	scenario: EvalScenario,
	overrides: Record<string, string | boolean>,
): EvalScenario {
	if (Object.keys(overrides).length === 0) return scenario;
	const isRuntimeSurfaceNoSubcalls =
		overrides["rlm-externalization-kernel"] === "no-subcalls" && scenario.id === "paper-runtime-surface";
	const turns =
		isRuntimeSurfaceNoSubcalls ?
			scenario.turns.map((turn) => (turn.id === "runtime-surface" ? { ...turn, prompt: rewriteRuntimeSurfacePromptForNoSubcalls(turn.prompt) } : turn))
			: scenario.turns;
	return {
		...scenario,
		turns,
		extensionFlags: {
			...(scenario.extensionFlags ?? {}),
			...overrides,
		},
	};
}

function printScenarios() {
	console.log("Scenarios:");
	for (const scenario of getEvalScenarios()) console.log(`${scenario.id}\t${scenario.label}`);
	console.log("\nProvider profiles:");
	for (const profile of getProviderProfiles()) console.log(`${profile.id}\t${profile.label}`);
}

function printHelp() {
	console.log(`Usage:
  npm run eval:list
  npm run eval -- --subject ./dist/index.js --spy-entrypoint ../pi-spy/src/index.ts --scenario rlm-refactor-review --model-id gpt-5.4 --auth-provider openai-codex
  npm run eval:compare -- --baseline ./eval/artifacts/main/dist/index.js --candidate ./dist/index.js --spy-entrypoint ../pi-spy/src/index.ts --scenario rlm-refactor-review --model-id gpt-5.4 --auth-provider openai-codex
  npm run eval:baseline -- --name main

Native-mode options:
  --spy-entrypoint              Path to the pi-spy extension entrypoint (required for run/compare)
  --model-id                    Model id to resolve from your normal Pi setup (required)
  --model-provider              Exact provider to use for model resolution
  --auth-provider               Preferred provider/auth namespace (e.g. openai-codex)
  --agent-dir                   Override the Pi agent dir used for auth/models
  --isolated-auth               Use isolated auth/models dir instead of shared Pi auth
  --api-key                     Runtime API key value for the resolved provider
  --reasoning                   true/false hint only; actual provider model capabilities still come from Pi
  --extension-flags             Comma-separated flags for both sides, e.g. rlm-enabled=true,rlm-externalization-kernel=no-subcalls
  --baseline-extension-flags    Compare-only overrides for the baseline side
  --candidate-extension-flags   Compare-only overrides for the candidate side

Notes:
  This runner now defaults to Pi-native observation using pi-spy.
  Pi does the real provider work; the runner just orchestrates scenarios and reads pi-spy telemetry.
`);
}

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function timestampSlug(value: string): string {
	return value.replace(/[:.]/g, "-");
}

function shortHash(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function trimPreview(value: string, limit = 1200): string {
	const trimmed = value.trim();
	if (!trimmed) return "(empty)";
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function formatContextStats(context: EvalContextStats): string {
	const parts = [`events ${context.eventCount}`];
	if (context.maxMessageCount !== undefined) parts.push(`max messages ${context.maxMessageCount}`);
	if (context.maxEstimatedChars !== undefined) parts.push(`max chars ${context.maxEstimatedChars}`);
	if (context.lastMessageCount !== undefined || context.lastEstimatedChars !== undefined) {
		parts.push(
			`last messages ${formatMaybeNumber(context.lastMessageCount)}, last chars ${formatMaybeNumber(context.lastEstimatedChars)}`,
		);
	}
	return parts.join(" · ");
}

function formatMaybeNumber(value: number | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function formatMs(value: number): string {
	return `${Math.round(value)}ms`;
}

function signed(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

function scheduleExit() {
	setTimeout(() => process.exit(process.exitCode ?? 0), 0);
}

void main()
	.catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exitCode = 1;
	})
	.finally(() => {
		scheduleExit();
	});
