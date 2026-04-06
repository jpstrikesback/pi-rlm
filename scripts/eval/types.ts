export type EvalProviderProfileId = "mlx" | "openai-chat" | "openai-responses";

export type EvalProviderUsageFormat = string;

export type EvalTurn = {
	id: string;
	title: string;
	prompt: string;
};

export type EvalScenario = {
	id: string;
	label: string;
	description: string;
	cwd: string;
	corpusSummary: string[];
	turns: EvalTurn[];
};

export type ProxyUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
};

export type ProxyLogEntry = {
	requestId: string;
	method: string;
	path?: string;
	url?: string;
	requestBodyText: string;
	requestBodyJson?: unknown;
	responseStatus?: number;
	responseText?: string;
	startedAt: string;
	durationMs: number;
	turnIndex: number;
	turnId: string;
	usage?: ProxyUsage;
};

export type EvalToolEvent = {
	phase: "start" | "end";
	toolName: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
};

export type EvalTurnResult = {
	turnIndex: number;
	turnId: string;
	title: string;
	prompt: string;
	durationMs: number;
	assistantText: string;
	assistantStopReason?: string;
	assistantErrorMessage?: string;
	requestCount: number;
	requests: ProxyLogEntry[];
	usage: ProxyUsage;
	tools: EvalToolEvent[];
	readPaths: string[];
	repeatedReadPaths: string[];
	rlmExecCount: number;
	childQueryCount: number;
	childTurns: number;
	firstRequestCanonical: string;
	firstRequestSharedPrefixCharsVsPreviousTurn?: number;
	firstRequestSharedPrefixRatioVsPreviousTurn?: number;
};

export type EvalRunResult = {
	createdAt: string;
	harnessVersion: 1;
	piVersion: string;
	repoRoot: string;
	scenario: EvalScenario;
	subject: {
		label: string;
		entrypoint: string;
	};
	model: {
		provider: string;
		id: string;
		providerProfile: EvalProviderProfileId;
		usageFormat: EvalProviderUsageFormat;
		upstreamBaseUrl: string;
		proxyBaseUrl: string;
		transportMode: "native" | "proxy";
		authAgentDir: string;
		isolatedAuth: boolean;
		cacheFieldMapping: {
			promptTokens: string;
			completionTokens: string;
			totalTokens: string;
			cacheHitTokens: string;
			cacheMissTokens: string;
		};
	};
	turns: EvalTurnResult[];
	summary: {
		totalDurationMs: number;
		totalRequests: number;
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cacheHitTokens: number;
		cacheMissTokens: number;
		totalToolCalls: number;
		totalRlmExecCount: number;
		totalChildQueryCount: number;
		totalChildTurns: number;
	};
};

export type EvalCompareResult = {
	createdAt: string;
	harnessVersion: 1;
	baseline: EvalRunResult;
	candidate: EvalRunResult;
	delta: {
		durationMs: number;
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cacheHitTokens: number;
		cacheMissTokens: number;
		toolCalls: number;
		rlmExecCount: number;
		childQueryCount: number;
		childTurns: number;
	};
};
