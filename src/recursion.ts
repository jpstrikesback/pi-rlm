import {
	createAgentSession,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	DefaultResourceLoader,
	SessionManager,
	type CreateAgentSessionOptions,
	type ExtensionContext,
	type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { BUDGET_PRESETS, buildChildPrompt, normalizeLlmQueryInput, parseChildResult } from "./llm-query.js";
import { buildChildHandoffFromBranch, RLM_RUNTIME_TYPE, RLM_WORKSPACE_TYPE } from "./restore.js";
import type {
	LlmQueryRequest,
	LlmQueryResult,
	LlmQueryTools,
	RlmBuiltInToolName,
	RlmChildProgressEvent,
	RuntimeSnapshot,
} from "./types.js";

const BUILT_IN_TOOL_NAMES: readonly RlmBuiltInToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOL_NAMES: RlmBuiltInToolName[] = ["read", "grep", "find", "ls"];
const CODING_TOOL_NAMES: RlmBuiltInToolName[] = ["read", "bash", "edit", "write"];

type ChildCheckpoint = ReturnType<typeof buildChildHandoffFromBranch>;

type ChildSessionRun = {
	text: string;
	turns: number;
	abortedByBudget: boolean;
};

function isBuiltInToolName(name: string): name is RlmBuiltInToolName {
	return BUILT_IN_TOOL_NAMES.includes(name as RlmBuiltInToolName);
}

function resolveBuiltInToolNames(mode: LlmQueryTools | undefined, parentActiveTools: string[]): RlmBuiltInToolName[] {
	if (!mode || mode === "read-only") return [...READ_ONLY_TOOL_NAMES];
	if (mode === "coding") return [...CODING_TOOL_NAMES];
	if (mode === "same") {
		const filtered = parentActiveTools.filter(isBuiltInToolName);
		return filtered.length > 0 ? filtered : [...READ_ONLY_TOOL_NAMES];
	}
	const filtered = mode.filter(isBuiltInToolName);
	return filtered.length > 0 ? filtered : [...READ_ONLY_TOOL_NAMES];
}

function buildBuiltInTools(cwd: string, names: RlmBuiltInToolName[]): AgentTool<any>[] {
	const unique = Array.from(new Set(names));
	if (unique.length === READ_ONLY_TOOL_NAMES.length && unique.every((name) => READ_ONLY_TOOL_NAMES.includes(name))) {
		return createReadOnlyTools(cwd);
	}
	if (unique.length === CODING_TOOL_NAMES.length && CODING_TOOL_NAMES.every((name) => unique.includes(name))) {
		return createCodingTools(cwd);
	}
	return unique.map((name) => {
		switch (name) {
			case "read":
				return createReadTool(cwd);
			case "bash":
				return createBashTool(cwd);
			case "edit":
				return createEditTool(cwd);
			case "write":
				return createWriteTool(cwd);
			case "grep":
				return createGrepTool(cwd);
			case "find":
				return createFindTool(cwd);
			case "ls":
				return createLsTool(cwd);
		}
	});
}

export { BUDGET_PRESETS, buildChildPrompt, normalizeLlmQueryInput, parseChildResult };

function createChildId(): string {
	return `child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildPromptPreview(prompt: string): string {
	const compact = prompt.trim().replace(/\s+/g, " ");
	return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
}

function buildResumeSnapshot(
	checkpoint: ChildCheckpoint | undefined,
	state: Record<string, unknown> | undefined,
): RuntimeSnapshot | undefined {
	const base = checkpoint?.snapshot
		? structuredClone(checkpoint.snapshot)
		: ({ version: 1, bindings: {}, entries: [] } satisfies RuntimeSnapshot);
	const hasBaseBindings = Object.keys(base.bindings).length > 0 || base.entries.length > 0;
	if (state && Object.keys(state).length > 0) {
		base.bindings.input = structuredClone(state);
		base.bindings.parentState = structuredClone(state);
		return base;
	}
	return hasBaseBindings ? base : undefined;
}

function seedSessionManager(
	sessionManager: SessionManager,
	options: {
		state?: Record<string, unknown>;
		checkpoint?: ChildCheckpoint;
	},
) {
	const resumeSnapshot = buildResumeSnapshot(options.checkpoint, options.state);
	if (resumeSnapshot) {
		sessionManager.appendCustomEntry(RLM_RUNTIME_TYPE, { snapshot: resumeSnapshot });
	}
	if (options.checkpoint?.workspace !== undefined) {
		sessionManager.appendCustomEntry(RLM_WORKSPACE_TYPE, { workspace: options.checkpoint.workspace });
	}
	if (!resumeSnapshot && options.state && Object.keys(options.state).length > 0) {
		sessionManager.appendCustomEntry("rlm-child-bootstrap", { state: options.state });
	}
}

function buildForcedFinalizePrompt(args: {
	prompt: string;
	checkpoint: ChildCheckpoint;
	outputMode: "text" | "json";
	schema?: Record<string, string>;
}): string {
	const sections: string[] = [];
	sections.push("You are a recursive RLM child node resuming from an internal checkpoint.");
	sections.push(`Original task:\n${args.prompt}`);
	if (args.checkpoint.summary) {
		sections.push(`Checkpoint summary:\n${args.checkpoint.summary}`);
	}
	sections.push("Rules:");
	sections.push("- No tools are available in this finalization step.");
	sections.push("- Use the restored runtime state and checkpoint context only.");
	sections.push("- Do not continue exploration or ask for more work.");
	sections.push("- Return the best final answer now.");
	if (args.outputMode === "json") {
		sections.push("- Return valid JSON only. Do not wrap it in markdown fences.");
		if (args.schema) {
			sections.push(`Requested JSON shape:\n${JSON.stringify(args.schema, null, 2)}`);
		}
	} else {
		sections.push("- Return only the final useful answer, without extra preamble.");
	}
	return sections.join("\n\n");
}

async function runChildSession(args: {
	ctx: ExtensionContext;
	extensionFactory: ExtensionFactory;
	sessionManager: SessionManager;
	tools: AgentTool<any>[];
	prompt: string;
	childId: string;
	maxTurns: number;
	onProgress?: (event: RlmChildProgressEvent) => void;
}): Promise<ChildSessionRun> {
	const loader = new DefaultResourceLoader({
		cwd: args.ctx.cwd,
		extensionFactories: [args.extensionFactory],
	});
	await loader.reload();

	const createOptions: CreateAgentSessionOptions = {
		cwd: args.ctx.cwd,
		sessionManager: args.sessionManager,
		resourceLoader: loader,
		tools: args.tools,
	};
	if (args.ctx.model) createOptions.model = args.ctx.model;

	const { session } = await createAgentSession(createOptions);
	let text = "";
	let turns = 0;
	let abortedByBudget = false;

	session.subscribe((event: any) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const content = event.message.content;
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) {
				text = content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
			}
		}
		if (event.type === "tool_execution_start") {
			args.onProgress?.({
				type: "tool_start",
				childId: args.childId,
				toolName: event.toolName,
			});
		}
		if (event.type === "tool_execution_end") {
			args.onProgress?.({
				type: "tool_end",
				childId: args.childId,
				toolName: event.toolName,
			});
		}
		if (event.type === "turn_end") {
			turns += 1;
			args.onProgress?.({ type: "turn_end", childId: args.childId, turns });
			if (turns >= args.maxTurns) {
				abortedByBudget = true;
				void session.abort();
			}
		}
	});

	try {
		await session.prompt(args.prompt);
	} catch (error) {
		if (!abortedByBudget) throw error;
	}

	return { text, turns, abortedByBudget };
}

export async function runChildQuery(
	input: LlmQueryRequest,
	ctx: ExtensionContext,
	options: {
		depth: number;
		maxDepth: number;
		extensionFactory: ExtensionFactory;
		parentActiveTools: string[];
		onProgress?: (event: RlmChildProgressEvent) => void;
	},
): Promise<LlmQueryResult> {
	const normalized = normalizeLlmQueryInput(input);
	const maxDepth = normalized.budget.maxDepth ?? options.maxDepth;
	if (options.depth > maxDepth) {
		throw new Error(`Max recursion depth reached (${maxDepth})`);
	}

	const childId = createChildId();
	options.onProgress?.({
		type: "start",
		childId,
		role: normalized.role,
		promptPreview: buildPromptPreview(normalized.prompt),
	});

	try {
		const primarySessionManager = SessionManager.inMemory(ctx.cwd);
		seedSessionManager(primarySessionManager, { state: normalized.state });

		const builtInToolNames = resolveBuiltInToolNames(normalized.tools, options.parentActiveTools);
		const builtInTools = buildBuiltInTools(ctx.cwd, builtInToolNames);
		const maxTurns = normalized.budget.maxTurns ?? BUDGET_PRESETS.medium.maxTurns!;

		const primary = await runChildSession({
			ctx,
			extensionFactory: options.extensionFactory,
			sessionManager: primarySessionManager,
			tools: builtInTools,
			prompt: buildChildPrompt(normalized),
			childId,
			maxTurns,
			onProgress: options.onProgress,
		});

		const parsedPrimary = parseChildResult(primary.text, normalized, primary.turns);
		if (!primary.abortedByBudget || parsedPrimary.ok) {
			if (parsedPrimary.ok) {
				options.onProgress?.({
					type: "end",
					childId,
					ok: true,
					turns: primary.turns,
					summary: parsedPrimary.summary,
				});
				return parsedPrimary;
			}
			options.onProgress?.({
				type: "error",
				childId,
				error: parsedPrimary.error || "Child query failed",
			});
			return parsedPrimary;
		}

		const checkpoint = buildChildHandoffFromBranch(primarySessionManager.getBranch(), {
			childId,
			role: normalized.role,
			depth: options.depth,
			turns: primary.turns,
			reason: "budget_exhausted",
			summary: primary.text.trim(),
			suggestedNextPrompt: normalized.prompt,
		});

		const finalizeSessionManager = SessionManager.inMemory(ctx.cwd);
		seedSessionManager(finalizeSessionManager, {
			checkpoint,
			state: normalized.state,
		});

		const finalize = await runChildSession({
			ctx,
			extensionFactory: options.extensionFactory,
			sessionManager: finalizeSessionManager,
			tools: [],
			prompt: buildForcedFinalizePrompt({
				prompt: normalized.prompt,
				checkpoint,
				outputMode: normalized.output.mode,
				schema: normalized.output.schema,
			}),
			childId,
			maxTurns: 1,
			onProgress: options.onProgress,
		});

		const totalTurns = primary.turns + finalize.turns;
		const parsedFinal = parseChildResult(finalize.text, normalized, totalTurns);
		if (parsedFinal.ok) {
			options.onProgress?.({
				type: "end",
				childId,
				ok: true,
				turns: totalTurns,
				summary: parsedFinal.summary,
			});
			return parsedFinal;
		}

		const fallbackAnswer = finalize.text.trim() || checkpoint.summary || primary.text.trim();
		const errorMessage = `Child query exceeded maxTurns (${maxTurns}) before producing a final answer`;
		const result: LlmQueryResult = {
			ok: false,
			answer: fallbackAnswer,
			summary: fallbackAnswer || undefined,
			role: normalized.role,
			usage: { turns: totalTurns },
			error: errorMessage,
		};
		options.onProgress?.({
			type: "error",
			childId,
			error: errorMessage,
		});
		return result;
	} catch (error) {
		options.onProgress?.({
			type: "error",
			childId,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
