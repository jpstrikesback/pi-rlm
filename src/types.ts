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
	live?: RlmLiveExecDetails;
};

export type RlmPromptMode = "balanced" | "coordinator" | "aggressive";

export type RlmExtensionOptions = {
	maxDepth?: number;
	promptMode?: RlmPromptMode;
};

export type RlmBuiltInToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

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
};

export type NormalizedLlmQueryRequest = {
	prompt: string;
	role: LlmQueryRole;
	state?: Record<string, unknown>;
	tools: LlmQueryTools;
	budget: LlmQueryBudget;
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
	promptMode: RlmPromptMode;
	depth: number;
	maxDepth: number;
	execCount: number;
	childQueryCount: number;
	childTurns: number;
	runtimeVarCount: number;
	leafToolCount: number;
};
