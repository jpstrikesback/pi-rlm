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
	extensionFlags?: Record<string, string | boolean>;
	setupPrompts?: string[];
	turns: EvalTurn[];
};

export type ProxyUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
};

export type EvalContextStats = {
	eventCount: number;
	lastMessageCount?: number;
	lastEstimatedChars?: number;
	maxMessageCount?: number;
	maxEstimatedChars?: number;
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

export type EvalWorkspaceCommitEvent = {
	changedKeys: string[];
	ignoredKeys: string[];
	planLength: number;
	findingCount: number;
	pendingConsolidation: boolean;
	activeContextSummaryPresent: boolean;
};

export type EvalWorkspaceState = {
	hasCommitted: boolean;
	pendingConsolidation: boolean;
	lastCommittedTurn?: number;
	lastLeafToolTurn?: number;
	lastCommitChangedKeys?: string[];
	planLength: number;
	findingCount: number;
	artifactCount: number;
	activeContextSummary?: string;
};

export type EvalSubmodelOverride = {
	kind: "simple" | "recursive";
	requested: string;
	resolvedProvider: string;
	resolvedId: string;
	thinkingLevel?: string;
};

export type EvalCommitTruthfulness = {
	claimedCommit: boolean;
	actualCommit: boolean;
	falseClaim: boolean;
	claimSignals: string[];
};

export type EvalPathCitation = {
	cited: string;
	resolvedPath: string;
	exists: boolean;
	kind?: "file" | "directory";
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
	repeatedReadRatio?: number;
	leafToolCount: number;
	rlmExecCount: number;
	childQueryCount: number;
	childTurns: number;
	attemptedSimpleQueryCount: number;
	attemptedSimpleBatchCount: number;
	attemptedRecursiveQueryCount: number;
	attemptedRecursiveBatchCount: number;
	simpleQueryCount: number;
	simpleBatchCount: number;
	recursiveQueryCount: number;
	recursiveBatchCount: number;
	submodelOverrideCount: number;
	submodelOverrides: EvalSubmodelOverride[];
	showVarsCount: number;
	finalAliasUsed: boolean;
	finalVarAliasUsed: boolean;
	commitCount: number;
	workspaceCommits: EvalWorkspaceCommitEvent[];
	committedAfterLeafTools: boolean;
	committedBeforeLeafTools: boolean;
	commitTruthfulness: EvalCommitTruthfulness;
	pathCitations: EvalPathCitation[];
	workspaceState?: EvalWorkspaceState;
	workspacePendingConsolidation?: boolean;
	workspaceHasCommitted?: boolean;
	runtimeBindingCountBefore?: number;
	runtimeBindingCountAfter?: number;
	runtimeNewBindingCount?: number;
	runtimeUpdatedBindingCount?: number;
	firstRequestCanonical: string;
	firstRequestSharedPrefixCharsVsPreviousTurn?: number;
	firstRequestSharedPrefixRatioVsPreviousTurn?: number;
	context?: EvalContextStats;
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
		totalAttemptedSimpleQueryCount: number;
		totalAttemptedSimpleBatchCount: number;
		totalAttemptedRecursiveQueryCount: number;
		totalAttemptedRecursiveBatchCount: number;
		totalSimpleQueryCount: number;
		totalSimpleBatchCount: number;
		totalRecursiveQueryCount: number;
		totalRecursiveBatchCount: number;
		totalSubmodelOverrideCount: number;
		totalShowVarsCount: number;
		turnsUsingFinalAlias: number;
		turnsUsingFinalVarAlias: number;
		totalWorkspaceCommits: number;
		turnsWithLeafTools: number;
		turnsWithCommitAfterLeafTools: number;
		postLeafCommitRate?: number;
		claimedCommitTurns: number;
		falseCommitClaimTurns: number;
		totalPathCitations: number;
		existingPathCitations: number;
		missingPathCitations: number;
		pathExistenceRate?: number;
		totalRuntimeNewBindingCount: number;
		totalRuntimeUpdatedBindingCount: number;
		totalReadPaths: number;
		totalRepeatedReadPaths: number;
		repeatedReadRatio?: number;
		turnsEndingPendingConsolidation: number;
		staleRecoveryOpportunities: number;
		staleRecoveries: number;
		staleRecoveryRate?: number;
		plateauRatio?: number;
		context?: {
			maxMessageCount?: number;
			maxEstimatedChars?: number;
			lastMessageCount?: number;
			lastEstimatedChars?: number;
		};
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
		workspaceCommits: number;
		postLeafCommitRate: number;
		falseCommitClaimTurns: number;
		missingPathCitations: number;
		pathExistenceRate: number;
		runtimeNewBindingCount: number;
		runtimeUpdatedBindingCount: number;
		repeatedReadRatio: number;
		staleRecoveryRate: number;
		plateauRatio: number;
	};
};
