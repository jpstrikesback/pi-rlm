export type InspectEntry = {
	name: string;
	type: string;
	size?: string;
	preview?: string;
	restorable: boolean;
};

export type GlobalsInspection = {
	entries: InspectEntry[];
	table: string;
};

export type RuntimeSnapshot = {
	version: 1;
	bindings: Record<string, unknown>;
	entries: InspectEntry[];
};

export type ExecResult = {
	ok: boolean;
	stdout: string;
	returnValuePreview?: string;
	error?: string;
	inspection: GlobalsInspection;
	snapshot: RuntimeSnapshot;
	finalValue?: unknown;
	commitCount?: number;
	commitResults?: RlmWorkspaceCommitResult[];
	workspaceState?: RlmExecWorkspaceState;
	attemptedSimpleQueryCount?: number;
	attemptedSimpleBatchCount?: number;
	attemptedRecursiveQueryCount?: number;
	attemptedRecursiveBatchCount?: number;
	simpleQueryCount?: number;
	simpleBatchCount?: number;
	recursiveQueryCount?: number;
	recursiveBatchCount?: number;
	submodelOverrideCount?: number;
	showVarsCount?: number;
	finalAliasUsed?: boolean;
	finalVarAliasUsed?: boolean;
	contextMessageCount?: number;
	historyCount?: number;
	runtimeBindingCountBefore?: number;
	runtimeBindingCountAfter?: number;
	runtimeNewBindingCount?: number;
	runtimeUpdatedBindingCount?: number;
};

export type RlmToolDetails = {
	turn: number;
	snapshot: RuntimeSnapshot;
	inspection: GlobalsInspection;
	stdout: string;
	returnValuePreview?: string;
	error?: string;
	finalValue?: unknown;
	childQueryCount?: number;
	childTurns?: number;
	commitCount?: number;
	commitResults?: RlmWorkspaceCommitResult[];
	workspaceState?: RlmExecWorkspaceState;
	attemptedSimpleQueryCount?: number;
	attemptedSimpleBatchCount?: number;
	attemptedRecursiveQueryCount?: number;
	attemptedRecursiveBatchCount?: number;
	simpleQueryCount?: number;
	simpleBatchCount?: number;
	recursiveQueryCount?: number;
	recursiveBatchCount?: number;
	submodelOverrideCount?: number;
	showVarsCount?: number;
	finalAliasUsed?: boolean;
	finalVarAliasUsed?: boolean;
	contextMessageCount?: number;
	historyCount?: number;
	runtimeBindingCountBefore?: number;
	runtimeBindingCountAfter?: number;
	runtimeNewBindingCount?: number;
	runtimeUpdatedBindingCount?: number;
	submodelOverrides?: RlmSubmodelOverride[];
	live?: RlmLiveExecDetails;
};

export type RlmTaskFewShotVariant =
	| "none"
	| "artifact-workflow-neutral-v1"
	| "artifact-workflow-openai-v1"
	| "artifact-workflow-local-v1";
export type RlmRootKickoffVariant = "none" | "recursive-scout-v1" | "recursive-chain-v1";

export type RlmPromptModeOverride<T> = {
	current?: T;
	"no-subcalls"?: T;
};

export type RlmProfilePromptOverrides = {
	rootKickoff?: RlmPromptModeOverride<{
		root?: string;
		exec?: string;
	}>;
	taskFewShot?: RlmPromptModeOverride<{
		root?: string;
		exec?: string;
	}>;
	execPromptSnippet?: RlmPromptModeOverride<string>;
	execCodeParamDescription?: RlmPromptModeOverride<string>;
	legacyDenseExecGuidelineLines?: RlmPromptModeOverride<string[]>;
};

export type RlmExecutionProfile = {
	name: string;
	description?: string;
	behavior: {
		guidanceVariant: string;
		taskFewShotVariant?: RlmTaskFewShotVariant;
		rootKickoffVariant?: RlmRootKickoffVariant;
		directToolBias?: "high" | "medium" | "low";
		runtimeBias?: "high" | "medium" | "low";
		recursiveBias?: "high" | "medium" | "low";
		shortestExecProgram?: boolean;
		avoidManualScanSubstitution?: boolean;
		simplifyAfterOptionalFailure?: boolean;
	};
	helpers?: {
		simpleChild?: {
			defaultModel?: RlmModelSelector;
			thinking?: RlmThinkingLevel;
			budget?: LlmQueryBudgetPreset;
		};
		recursiveChild?: {
			defaultModel?: RlmModelSelector;
			inheritParentByDefault?: boolean;
			thinking?: RlmThinkingLevel;
			budget?: LlmQueryBudgetPreset;
		};
	};
	fallback?: {
		onMissingSimpleChildModel?: "fail" | "warn-and-inherit" | "warn-and-disable";
		onMissingRecursiveChildModel?: "fail" | "warn-and-inherit" | "warn-and-disable";
	};
	promptOverrides?: RlmProfilePromptOverrides;
};

export type RlmResolvedExecutionProfile = {
	name: string;
	description?: string;
	behavior: Required<RlmExecutionProfile["behavior"]>;
	helpers: {
		simpleChild: {
			defaultModel?: RlmModelSelector;
			thinking?: RlmThinkingLevel;
			budget?: LlmQueryBudgetPreset;
			disabled?: boolean;
		};
		recursiveChild: {
			defaultModel?: RlmModelSelector;
			inheritParentByDefault: boolean;
			thinking?: RlmThinkingLevel;
			budget?: LlmQueryBudgetPreset;
			disabled?: boolean;
		};
	};
	fallback: {
		onMissingSimpleChildModel: "fail" | "warn-and-inherit" | "warn-and-disable";
		onMissingRecursiveChildModel: "fail" | "warn-and-inherit" | "warn-and-disable";
	};
	promptOverrides: RlmProfilePromptOverrides;
};

export type RlmExternalizationKernelMode = "current" | "no-subcalls";

export type RlmExtensionOptions = {
	maxDepth?: number;
	profile?: string;
	profiles?: Record<string, RlmExecutionProfile>;
	profileConfigPath?: string;
	externalizationKernel?: RlmExternalizationKernelMode;
};

export type RlmBuiltInToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export type RlmThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type RlmModelSelector = `${string}/${string}` | `${string}/${string}:${RlmThinkingLevel}`;
export type RlmQueryMode = "simple" | "recursive";
export type RlmSubmodelOverride = {
	kind: RlmQueryMode;
	requested: string;
	resolvedProvider: string;
	resolvedId: string;
	thinkingLevel?: RlmThinkingLevel;
};

export type LlmQueryRole = "general" | "scout" | "planner" | "worker" | "reviewer";
export type LlmQueryTools = "same" | "read-only" | "coding" | RlmBuiltInToolName[];
export type LlmQueryOutputMode = "text" | "json";
export type LlmQueryBudgetPreset = "low" | "medium" | "high";

export type LlmQueryBudget = {
	maxDepth?: number;
	maxTurns?: number;
};

export type LlmQueryOutput = {
	mode?: LlmQueryOutputMode;
	schema?: Record<string, string>;
};

export type LlmQueryRequest = {
	prompt: string;
	role?: LlmQueryRole;
	state?: Record<string, unknown>;
	tools?: LlmQueryTools;
	budget?: LlmQueryBudgetPreset | LlmQueryBudget;
	output?: LlmQueryOutput;
	model?: RlmModelSelector;
};

export type NormalizedLlmQueryRequest = {
	prompt: string;
	role: LlmQueryRole;
	state?: Record<string, unknown>;
	tools: LlmQueryTools;
	budget: LlmQueryBudget;
	model?: RlmModelSelector;
	output: {
		mode: LlmQueryOutputMode;
		schema?: Record<string, string>;
	};
};

export type LlmQueryResult = {
	ok: boolean;
	answer: string;
	summary?: string;
	data?: Record<string, unknown>;
	role?: LlmQueryRole;
	usage?: {
		turns?: number;
	};
	error?: string;
};

export type RlmArtifactStatus = "ok" | "error" | "budget_exhausted" | "interrupted";

export type RlmArtifactIndex = {
	byId?: Record<string, RlmChildArtifact>;
	byTag?: Record<string, string[]>;
	byFile?: Record<string, string[]>;
	recentIds?: string[];
};

export type RlmActiveContext = {
	goal?: string;
	currentPlan?: string | string[];
	relevantFiles?: string[];
	currentQuestions?: string[];
	currentFindingsRefs?: string[];
	currentArtifactRefs?: string[];
	summary?: string;
	updatedAt?: string;
};

export type RlmRuntimeContextMessage = {
	role: "user" | "assistant" | "tool";
	text: string;
	toolName?: string;
	isError?: boolean;
};

export type RlmHistoryTurn = {
	turnIndex: number;
	user: string;
	assistant?: string;
	tools: string[];
};

export type RlmRuntimeContext = {
	query?: string;
	workspace?: RlmWorkspace | null;
	activeContext?: RlmActiveContext;
	artifactSummaries?: RlmArtifactSummary[];
	retention?: RlmWorkspace["retention"];
	parentState?: Record<string, unknown>;
	input?: Record<string, unknown>;
	compiledContext?: RlmCompiledContext;
	messages: RlmRuntimeContextMessage[];
};

export type RlmRuntimeSimpleQueryOptions = {
	model?: RlmModelSelector;
	output?: LlmQueryOutput;
};

export type RlmRuntimeRecursiveQueryOptions = {
	model?: RlmModelSelector;
	role?: LlmQueryRole;
	state?: Record<string, unknown>;
	tools?: LlmQueryTools;
	budget?: LlmQueryBudgetPreset | LlmQueryBudget;
	output?: LlmQueryOutput;
};

export type RlmRuntimeBatchQueryItem =
	| string
	| ({ prompt: string } & RlmRuntimeSimpleQueryOptions)
	| ({ prompt: string } & RlmRuntimeRecursiveQueryOptions);

export type RlmRetentionMetrics = {
	version: 1;
	keptMessages: number;
	prunedMessages: number;
	placeholderMessages: number;
	retainedTurns: number;
	prunedTurns: number;
	activeContextSummary?: string;
};

export type RlmRetentionPolicy = {
	keepRecentUserTurns: number;
	keepRecentAssistantTurns: number;
	keepRecentToolTurns: number;
	expireConsolidatedAfterTurns: number;
	replaceExpiredWithReference: boolean;
	keepUnresolvedToolFlows: boolean;
	keepLatestSurfaceSummary: boolean;
};

export type RlmRetentionEntry = {
	version: 1;
	turnIndex: number;
	policy: RlmRetentionPolicy;
	metrics: RlmRetentionMetrics;
	workspaceSummary?: string;
};

export type RlmConsolidationRef = {
	kind: "workspace-path" | "artifact-id" | "partial-output";
	ref: string;
	summary?: string;
};

export type RlmToolSurfaceResult = {
	text: string;
	refs?: RlmConsolidationRef[];
	details?: unknown;
};

export type RlmLease = {
	id: string;
	source: "assistant" | "tool";
	sourceName?: string;
	turnIndex: number;
	messageFingerprint: string;
	status: "live" | "consolidated" | "expired";
	consolidatedTo?: RlmConsolidationRef[];
	expiresAfterTurns?: number;
	createdAt: string;
	updatedAt: string;
};

export type RlmWorkspaceCommitPatch = {
	goal?: string;
	plan?: string[];
	files?: string[];
	findings?: Array<string | Record<string, unknown>>;
	openQuestions?: string[];
	partialOutputs?: Record<string, unknown>;
};

export type RlmWorkspaceCommitResult = {
	ok: true;
	changedKeys: string[];
	ignoredKeys: string[];
	activeContextSummary?: string;
	planLength: number;
	findingCount: number;
	pendingConsolidation: boolean;
	consolidatedEvidenceIds?: string[];
	consolidatedBurstIds?: string[];
	meaningfulPendingBeforeCommit?: number;
	meaningfulPendingAfterCommit?: number;
	satisfiedProtocol?: boolean;
};

export type RlmWorkspaceCoordination = {
	hasCommitted?: boolean;
	pendingConsolidation?: boolean;
	lastCommittedTurn?: number;
	lastLeafToolTurn?: number;
	lastCommitChangedKeys?: string[];
	pendingBurstIds?: string[];
	meaningfulPendingBurstIds?: string[];
	lastCommitConsolidatedIds?: string[];
	lastCommitConsolidatedBurstIds?: string[];
	lastCommitSatisfiedProtocol?: boolean;
};

export type RlmWorkspaceMeta = {
	version: 1;
	updatedAt?: string;
	activePlanRef?: string;
	activeArtifactRefs?: string[];
	leafBurstProtocolEnabled?: boolean;
	coordination?: RlmWorkspaceCoordination;
};

export type RlmEvidenceTrust = "grounded" | "derived";
export type RlmEvidenceStatus = "pending" | "committed";

export type RlmEvidenceSourceRef = {
	kind: "path" | "tool" | "workspace-path" | "artifact-id" | "evidence-id";
	ref: string;
};

export type RlmEvidenceItem = {
	id: string;
	turnIndex: number;
	kind: "tool" | "commit";
	summary: string;
	burstId?: string;
	toolName?: string;
	toolNames?: string[];
	files?: string[];
	refs?: string[];
	sourceRefs?: RlmEvidenceSourceRef[];
	changedKeys?: string[];
	consolidatedIds?: string[];
	trust?: RlmEvidenceTrust;
	salience?: number;
	status?: RlmEvidenceStatus;
	committed?: boolean;
	createdAt: string;
	updatedAt?: string;
};

export type RlmEvidenceCheckpoint = {
	id: string;
	turnIndex: number;
	summary: string;
	itemIds: string[];
	files?: string[];
	refs?: string[];
	trust?: RlmEvidenceTrust;
	salience?: number;
	createdAt: string;
	updatedAt?: string;
};

export type RlmPendingEvidenceBurst = {
	id: string;
	turnIndex: number;
	itemIds: string[];
	toolNames?: string[];
	files?: string[];
	summary: string;
	salience: number;
	requiresCommit: boolean;
	createdAt: string;
	updatedAt?: string;
};

export type RlmWorkspace = Record<string, unknown> & {
	goal?: string;
	plan?: string[];
	files?: string[];
	findings?: Array<string | Record<string, unknown>>;
	openQuestions?: string[];
	partialOutputs?: Record<string, unknown>;
	childArtifacts?: RlmChildArtifact[];
	childArtifactSummaries?: RlmArtifactSummary[];
	lastChildArtifact?: RlmChildArtifact;
	artifactIndex?: RlmArtifactIndex;
	activeContext?: RlmActiveContext;
	retention?: {
		latestMetrics?: RlmRetentionMetrics;
		latestTurnIndex?: number;
		latestSurfaceSummary?: string;
		leases?: RlmLease[];
	};
	evidence?: {
		latestTurnIndex?: number;
		pendingIds?: string[];
		items?: RlmEvidenceItem[];
		checkpoints?: RlmEvidenceCheckpoint[];
	};
	meta?: RlmWorkspaceMeta;
};

export type RlmChildArtifact = {
	version: 1;
	id: string;
	childId: string;
	kind: "child-query";
	role: LlmQueryRole;
	depth: number;
	turns: number;
	status: Exclude<RlmArtifactStatus, "interrupted">;
	prompt: string;
	answer: string;
	summary?: string;
	data?: Record<string, unknown>;
	error?: string;
	state?: Record<string, unknown>;
	files?: string[];
	tags?: string[];
	producedAt: string;
	snapshot?: RuntimeSnapshot;
	workspace?: RlmWorkspace | null;
};

export type RlmArtifactSummary = {
	id: string;
	childId: string;
	role: LlmQueryRole;
	status: RlmArtifactStatus;
	summary?: string;
	files?: string[];
	tags?: string[];
	producedAt?: string;
};

export type RlmValueManifest = {
	path: string;
	type: string;
	length?: number;
	keyCount?: number;
	keys?: string[];
	preview?: unknown;
};

export type RlmWorkspaceManifest = {
	version: 1;
	runtime: {
		workspacePath: "globalThis.workspace";
		parentStatePath: "globalThis.parentState";
		inputPath: "globalThis.input";
	};
	sections: Record<string, RlmValueManifest>;
	artifactCount: number;
	recentArtifactIds?: string[];
	relevantArtifacts?: RlmArtifactSummary[];
};

export type RlmCompiledContextHandle = {
	kind: "workspace-section" | "evidence-item" | "evidence-checkpoint" | "artifact";
	ref: string;
	summary: string;
	path?: string;
	files?: string[];
	trust?: RlmEvidenceTrust;
};

export type RlmCompiledExactValue = {
	path: string;
	reason: string;
	value: string;
};

export type RlmCompiledContext = {
	version: 1;
	currentAsk?: string;
	activeContextSummary?: string;
	pointerHints?: string;
	workspaceManifest?: RlmWorkspaceManifest;
	parentStateManifest?: RlmValueManifest;
	handles: RlmCompiledContextHandle[];
	exactValues: RlmCompiledExactValue[];
	executionMetadata: string[];
};

export type LlmQueryFunction = (input: LlmQueryRequest) => Promise<LlmQueryResult>;

export type RlmChildProgressEvent =
	| {
			type: "start";
			childId: string;
			role: LlmQueryRole;
			promptPreview: string;
	  }
	| {
			type: "turn_end";
			childId: string;
			turns: number;
	  }
	| {
			type: "tool_start";
			childId: string;
			toolName: string;
	  }
	| {
			type: "tool_end";
			childId: string;
			toolName: string;
	  }
	| {
			type: "end";
			childId: string;
			ok: boolean;
			turns: number;
			summary?: string;
	  }
	| {
			type: "error";
			childId: string;
			error: string;
	  };

export type RlmChildActivity = {
	childId: string;
	role: LlmQueryRole;
	promptPreview: string;
	status: "running" | "done" | "error";
	turns: number;
	activeTool?: string;
	summary?: string;
	error?: string;
};

export type RlmLiveExecDetails = {
	children: RlmChildActivity[];
};

export type RlmSessionStats = {
	enabled: boolean;
	profile: string;
	depth: number;
	maxDepth: number;
	execCount: number;
	childQueryCount: number;
	childTurns: number;
	runtimeVarCount: number;
	activeContextRefCount: number;
	leafToolCount: number;
};

export type RlmExecWorkspaceState = {
	hasCommitted: boolean;
	pendingConsolidation: boolean;
	lastCommittedTurn?: number;
	lastLeafToolTurn?: number;
	lastCommitChangedKeys?: string[];
	pendingBurstCount?: number;
	meaningfulPendingBurstCount?: number;
	lastCommitSatisfiedProtocol?: boolean;
	planLength: number;
	findingCount: number;
	artifactCount: number;
	activeContextSummary?: string;
};
