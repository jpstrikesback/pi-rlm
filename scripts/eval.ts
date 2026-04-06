import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { canonicalizeProviderPayload, longestCommonPrefixChars, safeRatio } from "./eval/metrics.js";
import { findProviderProfile, getProviderProfiles } from "./eval/provider-profiles.js";
import { findScenario, getEvalScenarios, getPinnedPiVersion, getRepoRoot } from "./eval/scenarios.js";
import type {
	EvalCompareResult,
	EvalRunResult,
	EvalScenario,
	EvalToolEvent,
	EvalTurnResult,
	ProxyLogEntry,
	ProxyUsage,
} from "./eval/types.js";

const PI_SPY_ENTRYPOINT = path.resolve(os.homedir(), "Code/personal/pi-spy/src/index.ts");

type CliArgs = Record<string, string | boolean>;

type NativeRunOptions = {
	subjectEntrypoint: string;
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

	for (const scenario of scenarios) {
		const result = await runNativeScenario({
			subjectEntrypoint: subject,
			subjectLabel: label,
			scenario,
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

	for (const scenario of scenarios) {
		const shared = {
			scenario,
			modelId,
			providerProfile,
			modelProviderOverride: stringArg(args, "modelProvider"),
			authProviderOverride: stringArg(args, "authProvider"),
			authAgentDir: resolveEvalAgentDir({ agentDir: stringArg(args, "agentDir") }),
			isolatedAuth: booleanArg(args, "isolatedAuth") ?? false,
			apiKeySource: stringArg(args, "apiKey"),
			reasoning: booleanArg(args, "reasoning") ?? false,
		} satisfies Omit<NativeRunOptions, "subjectEntrypoint" | "subjectLabel">;

		const baselineResult = await runNativeScenario({
			subjectEntrypoint: baseline,
			subjectLabel: String(args.baselineLabel ?? "baseline"),
			...shared,
		});
		const candidateResult = await runNativeScenario({
			subjectEntrypoint: candidate,
			subjectLabel: String(args.candidateLabel ?? "candidate"),
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

async function runNativeScenario(options: NativeRunOptions): Promise<EvalRunResult> {
	const subjectEntrypoint = await resolveSubjectEntrypoint(options.subjectEntrypoint);
	const runRoot = await mkdtemp(path.join(os.tmpdir(), "pi-rlm-eval-native-"));
	const sessionAgentDir = path.join(runRoot, "agent");
	const spyLogPath = path.join(runRoot, "pi-spy.jsonl");
	await mkdir(sessionAgentDir, { recursive: true });

	const effectiveAuthAgentDir = options.isolatedAuth ? sessionAgentDir : options.authAgentDir;
	await mkdir(effectiveAuthAgentDir, { recursive: true });
	const authStorage = AuthStorage.create(path.join(effectiveAuthAgentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, path.join(effectiveAuthAgentDir, "models.json"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

	const selectedModel = resolveNativeModel(modelRegistry, options, authStorage);
	if (!selectedModel) {
		throw new Error(
			`Could not resolve model ${options.modelId}. Try --model-provider <provider>. Available matching providers: ${findMatchingProviders(modelRegistry, options.modelId).join(", ") || "(none)"}`,
		);
	}
	if (options.reasoning && selectedModel.reasoning === false) {
		// keep going, but make it visible in logs later via selected model metadata
	}
	if (options.apiKeySource) {
		authStorage.setRuntimeApiKey(selectedModel.provider, resolveConfigValueLikePi(options.apiKeySource));
	}

	const resolvedSubjectEntrypoint = path.resolve(subjectEntrypoint);
	const resolvedSpyEntrypoint = path.resolve(PI_SPY_ENTRYPOINT);
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

	let unsubscribe: (() => void) | undefined;
	try {
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: options.scenario.cwd,
			model: selectedModel,
			authStorage,
			modelRegistry,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(options.scenario.cwd),
		});
		await session.bindExtensions({});

		const turns: EvalTurnResult[] = [];
		let currentTools: EvalToolEvent[] = [];
		let currentReadPaths: string[] = [];
		let currentAssistantDeltas = "";
		let currentRlmExecCount = 0;
		let currentChildQueryCount = 0;
		let currentChildTurns = 0;
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

		for (let turnIndex = 0; turnIndex < options.scenario.turns.length; turnIndex += 1) {
			const turn = options.scenario.turns[turnIndex];
			currentTools = [];
			currentReadPaths = [];
			currentAssistantDeltas = "";
			currentRlmExecCount = 0;
			currentChildQueryCount = 0;
			currentChildTurns = 0;
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
				rlmExecCount: currentRlmExecCount,
				childQueryCount: currentChildQueryCount,
				childTurns: currentChildTurns,
				firstRequestCanonical,
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
		};

		return {
			createdAt: new Date().toISOString(),
			harnessVersion: 1,
			piVersion: getPinnedPiVersion(),
			repoRoot: getRepoRoot(),
			scenario: options.scenario,
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
		unsubscribe?.();
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
		"",
		"## Turns",
		"",
	];
	for (const turn of result.turns) {
		lines.push(`### ${turn.turnIndex + 1}. ${turn.title}`);
		lines.push(`- Requests: ${turn.requestCount}`);
		lines.push(`- Duration: ${formatMs(turn.durationMs)}`);
		lines.push(`- Usage: prompt ${turn.usage.promptTokens}, completion ${turn.usage.completionTokens}, cache hit ${turn.usage.cacheHitTokens}, cache miss ${turn.usage.cacheMissTokens}`);
		if (turn.firstRequestCanonical) {
			lines.push(`- First request canonical: ${turn.firstRequestCanonical.length} chars, hash ${shortHash(turn.firstRequestCanonical)}`);
		}
		lines.push(`- Tools: ${turn.tools.filter((tool) => tool.phase === "start").length}, rlm_exec ${turn.rlmExecCount}, child ${turn.childQueryCount}/${turn.childTurns}`);
		if (turn.assistantStopReason) lines.push(`- Assistant stop reason: ${turn.assistantStopReason}`);
		if (turn.assistantErrorMessage) lines.push(`- Assistant error: ${turn.assistantErrorMessage}`);
		if (turn.firstRequestSharedPrefixCharsVsPreviousTurn !== undefined) {
			lines.push(`- First request shared prefix vs previous turn: ${turn.firstRequestSharedPrefixCharsVsPreviousTurn} chars (${(100 * (turn.firstRequestSharedPrefixRatioVsPreviousTurn ?? 0)).toFixed(1)}%)`);
		}
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
		"",
		"## Prefix drift evidence",
		"",
		...renderPrefixEvidence(result),
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

function describePrefixEvidence(turn: EvalTurnResult): string {
	if (!turn.firstRequestCanonical) {
		return `no provider payload captured; usage prompt/cache=${turn.usage.promptTokens}/${turn.usage.cacheHitTokens}/${turn.usage.cacheMissTokens}`;
	}
	const prefix = turn.firstRequestSharedPrefixCharsVsPreviousTurn === undefined
		? "n/a vs previous"
		: `${turn.firstRequestSharedPrefixCharsVsPreviousTurn} chars (${(100 * (turn.firstRequestSharedPrefixRatioVsPreviousTurn ?? 0)).toFixed(1)}%) vs previous`;
	return `${turn.requestCount} request(s); first canonical ${turn.firstRequestCanonical.length} chars, hash ${shortHash(turn.firstRequestCanonical)}, shared prefix ${prefix}; usage prompt/cache=${turn.usage.promptTokens}/${turn.usage.cacheHitTokens}/${turn.usage.cacheMissTokens}`;
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

function printScenarios() {
	console.log("Scenarios:");
	for (const scenario of getEvalScenarios()) console.log(`${scenario.id}\t${scenario.label}`);
	console.log("\nProvider profiles:");
	for (const profile of getProviderProfiles()) console.log(`${profile.id}\t${profile.label}`);
}

function printHelp() {
	console.log(`Usage:
  npm run eval:list
  npm run eval -- --subject ./dist/index.js --scenario rlm-refactor-review --model-id gpt-5.4 --auth-provider openai-codex
  npm run eval:compare -- --baseline ./eval/artifacts/main/dist/index.js --candidate ./dist/index.js --scenario rlm-refactor-review --model-id gpt-5.4 --auth-provider openai-codex
  npm run eval:baseline -- --name main

Native-mode options:
  --model-id         Model id to resolve from your normal Pi setup (required)
  --model-provider   Exact provider to use for model resolution
  --auth-provider    Preferred provider/auth namespace (e.g. openai-codex)
  --agent-dir        Override the Pi agent dir used for auth/models
  --isolated-auth    Use isolated auth/models dir instead of shared Pi auth
  --api-key          Runtime API key value for the resolved provider
  --reasoning        true/false hint only; actual provider model capabilities still come from Pi

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

function formatMs(value: number): string {
	return `${Math.round(value)}ms`;
}

function signed(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
