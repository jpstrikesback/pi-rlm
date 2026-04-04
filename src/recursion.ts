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
import type {
	LlmQueryRequest,
	LlmQueryResult,
	LlmQueryTools,
	RlmBuiltInToolName,
	RlmChildProgressEvent,
} from "./types.js";

const BUILT_IN_TOOL_NAMES: readonly RlmBuiltInToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READ_ONLY_TOOL_NAMES: RlmBuiltInToolName[] = ["read", "grep", "find", "ls"];
const CODING_TOOL_NAMES: RlmBuiltInToolName[] = ["read", "bash", "edit", "write"];

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
		const sessionManager = SessionManager.inMemory(ctx.cwd);
		if (normalized.state && Object.keys(normalized.state).length > 0) {
			sessionManager.appendCustomEntry("rlm-child-bootstrap", { state: normalized.state });
		}

		const builtInToolNames = resolveBuiltInToolNames(normalized.tools, options.parentActiveTools);
		const builtInTools = buildBuiltInTools(ctx.cwd, builtInToolNames);

		const loader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			extensionFactories: [options.extensionFactory],
		});
		await loader.reload();

		const createOptions: CreateAgentSessionOptions = {
			cwd: ctx.cwd,
			sessionManager,
			resourceLoader: loader,
			tools: builtInTools,
		};
		if (ctx.model) createOptions.model = ctx.model;

		const { session } = await createAgentSession(createOptions);

		let text = "";
		let turns = 0;
		let abortedByBudget = false;
		const maxTurns = normalized.budget.maxTurns ?? BUDGET_PRESETS.medium.maxTurns!;

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
				options.onProgress?.({
					type: "tool_start",
					childId,
					toolName: event.toolName,
				});
			}
			if (event.type === "tool_execution_end") {
				options.onProgress?.({
					type: "tool_end",
					childId,
					toolName: event.toolName,
				});
			}
			if (event.type === "turn_end") {
				turns += 1;
				options.onProgress?.({ type: "turn_end", childId, turns });
				if (turns >= maxTurns) {
					abortedByBudget = true;
					void session.abort();
				}
			}
		});

		try {
			await session.prompt(buildChildPrompt(normalized));
		} catch (error) {
			if (abortedByBudget) {
				const result = {
					ok: false,
					answer: text.trim(),
					role: normalized.role,
					usage: { turns },
					error: `Child query exceeded maxTurns (${maxTurns})`,
				} satisfies LlmQueryResult;
				options.onProgress?.({
					type: "error",
					childId,
					error: result.error || `Child query exceeded maxTurns (${maxTurns})`,
				});
				return result;
			}
			throw error;
		}

		const parsed = parseChildResult(text, normalized, turns);
		options.onProgress?.({
			type: "end",
			childId,
			ok: parsed.ok,
			turns,
			summary: parsed.summary,
		});
		return parsed;
	} catch (error) {
		options.onProgress?.({
			type: "error",
			childId,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
