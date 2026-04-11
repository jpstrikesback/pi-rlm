import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	buildCompiledPromptContext,
	renderCompiledPromptContext,
	buildWorkspacePointerHints,
	buildWorkspaceWorkingSetSummary,
	hasCommittedWorkspaceState,
} from "./workspace.js";
import type {
	RlmExternalizationKernelMode,
	RlmRetentionMetrics,
	RlmRetentionPolicy,
	RlmWorkspace,
} from "./types.js";

export const RLM_RETENTION_TYPE = "rlm-retention";

export const DEFAULT_RLM_RETENTION_POLICY: RlmRetentionPolicy = {
	keepRecentUserTurns: 1,
	keepRecentAssistantTurns: 1,
	keepRecentToolTurns: 1,
	expireConsolidatedAfterTurns: 2,
	replaceExpiredWithReference: true,
	keepUnresolvedToolFlows: true,
	keepLatestSurfaceSummary: true,
};

export const COMMITTED_RLM_RETENTION_POLICY: RlmRetentionPolicy = {
	keepRecentUserTurns: 1,
	keepRecentAssistantTurns: 1,
	keepRecentToolTurns: 0,
	expireConsolidatedAfterTurns: 1,
	replaceExpiredWithReference: true,
	keepUnresolvedToolFlows: true,
	keepLatestSurfaceSummary: true,
};

export type RlmRetentionResult = {
	messages: AgentMessage[];
	metrics: RlmRetentionMetrics;
};

function isSummaryMessage(message: AgentMessage): boolean {
	return message.role === "branchSummary" || message.role === "compactionSummary";
}

function isLegacyRlmContextMessage(message: AgentMessage): boolean {
	return message.role === "custom" && typeof (message as { customType?: unknown }).customType === "string" && (message as { customType: string }).customType === "rlm-context";
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function trimForSummary(value: string | undefined, maxChars = 220): string | undefined {
	if (!value) return undefined;
	const compact = value.trim().replace(/\s+/g, " ");
	if (!compact) return undefined;
	return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function buildExternalizationKernelMessage(
	workspace: RlmWorkspace | null | undefined,
	timestamp: number,
	prompt?: string,
	options: { replacementForPrunedContext?: boolean } = {},
): AgentMessage | undefined {
	const compiled = buildCompiledPromptContext(workspace, {
		prompt,
		role: "worker",
		evidenceItemLimit: 4,
		evidenceCheckpointLimit: 3,
		artifactLimit: 4,
		exactValueLimit: 2,
	});
	return {
		role: "user",
		content: renderCompiledPromptContext(compiled, {
			title: options.replacementForPrunedContext
				? "Earlier transcript context has been replaced by a deterministic compiled working set from externalized state."
				: "Deterministic compiled working set from externalized state.",
		}),
		timestamp,
	};
}

function buildWorkspaceProjectionMessage(
	workspace: RlmWorkspace | null | undefined,
	timestamp: number,
	prompt: string | undefined,
	options: { replacementForPrunedContext?: boolean } = {},
): AgentMessage | undefined {
	const compiled = buildCompiledPromptContext(workspace, {
		prompt,
		role: "worker",
		evidenceItemLimit: 4,
		evidenceCheckpointLimit: 3,
		artifactLimit: 4,
		exactValueLimit: 2,
	});
	if (!compiled.activeContextSummary && compiled.handles.length === 0 && compiled.exactValues.length === 0 && !compiled.pointerHints) return undefined;
	const text = renderCompiledPromptContext(compiled, {
		title: options.replacementForPrunedContext
			? "Earlier transcript context was replaced by a deterministic compiled working set. Prefer externalized handles over replay."
			: "Deterministic compiled working set. Prefer externalized handles over transcript replay.",
	});
	const pendingNote = workspace?.meta?.coordination?.pendingConsolidation
		? "\n\nPending: recent leaf-tool output has not been committed yet. Prefer rlm_exec + globalThis.workspace.commit({...}) before relying on older transcript."
		: "";
	return {
		role: "user",
		content: `${text}${pendingNote}`,
		timestamp,
	};
}

function buildToolResultPlaceholder(message: AgentMessage, workspace: RlmWorkspace | null | undefined): AgentMessage {
	const toolMessage = message as Extract<AgentMessage, { role: "toolResult" }>;
	const toolName = typeof toolMessage.toolName === "string" ? toolMessage.toolName : "tool";
	const ref = workspace ? "globalThis.workspace.activeContext" : undefined;
	const text = ref
		? `${toolName} output omitted from live context. Inspect ${ref} or branch history if the exact older output is needed.`
		: `Earlier ${toolName} output omitted from live context. Re-run the tool or inspect branch history if the exact older output is needed.`;
	return {
		role: "toolResult",
		toolCallId: toolMessage.toolCallId,
		toolName: toolMessage.toolName,
		isError: toolMessage.isError,
		timestamp: toolMessage.timestamp,
		details: toolMessage.details,
		content: [{ type: "text", text }],
	};
}

function projectHistoricalMessage(
	message: AgentMessage,
	workspace: RlmWorkspace | null | undefined,
	currentTurnIndex: number,
	messageTurnIndex: number,
): { message: AgentMessage; placeholder: boolean } {
	if (messageTurnIndex >= currentTurnIndex) return { message, placeholder: false };
	if (message.role === "toolResult" && message.isError !== true) {
		return {
			message: buildToolResultPlaceholder(message, workspace),
			placeholder: true,
		};
	}
	return { message, placeholder: false };
}

function buildTurns(messages: AgentMessage[]) {
	const turns: Array<{
		index: number;
		messages: AgentMessage[];
		hasAssistant: boolean;
		hasTool: boolean;
		hasErrorTool: boolean;
	}> = [];
	const prelude: AgentMessage[] = [];
	let turnIndex = -1;

	for (const message of messages) {
		if (isSummaryMessage(message)) continue;
		if (message.role === "user") {
			turnIndex += 1;
			turns.push({ index: turnIndex, messages: [], hasAssistant: false, hasTool: false, hasErrorTool: false });
		}
		if (turnIndex < 0) {
			prelude.push(message);
			continue;
		}
		const turn = turns[turns.length - 1];
		turn.messages.push(message);
		if (message.role === "assistant") turn.hasAssistant = true;
		if (message.role === "toolResult") {
			turn.hasTool = true;
			if (message.isError === true) turn.hasErrorTool = true;
		}
	}
	return { turns, prelude };
}

function buildPlaceholderMessage(timestamp: number): AgentMessage {
	return {
		role: "user",
		content:
			"Earlier RLM context was consolidated into globalThis.workspace.activeContext. Inspect globalThis.workspace instead of replaying old transcript history.",
		timestamp,
	};
}

function selectRetainedTurnIndexes(
	turns: ReturnType<typeof buildTurns>["turns"],
	policy: RlmRetentionPolicy,
): Set<number> {
	const keepTurns = new Set<number>();
	const addLast = (values: number[], count: number) => {
		if (count <= 0) return;
		values.slice(-count).forEach((value) => keepTurns.add(value));
	};
	const userTurnIndexes = turns.map((turn) => turn.index);
	const keepUserCount = Math.max(1, policy.keepRecentUserTurns, policy.expireConsolidatedAfterTurns);
	addLast(userTurnIndexes, keepUserCount);
	addLast(turns.filter((turn) => turn.hasAssistant).map((turn) => turn.index), policy.keepRecentAssistantTurns);
	addLast(turns.filter((turn) => turn.hasTool).map((turn) => turn.index), policy.keepRecentToolTurns);
	if (policy.keepUnresolvedToolFlows) turns.filter((turn) => turn.hasErrorTool).forEach((turn) => keepTurns.add(turn.index));
	if (keepTurns.size === 0 && turns.length > 0) keepTurns.add(turns[turns.length - 1].index);
	return keepTurns;
}

function buildProjectionPrelude(
	workspace: RlmWorkspace | null | undefined,
	timestamp: number,
	prompt: string | undefined,
	externalizationKernel: RlmExternalizationKernelMode | undefined,
	replacementForPrunedContext: boolean,
): AgentMessage[] {
	const message = externalizationKernel === "no-subcalls"
		? buildExternalizationKernelMessage(workspace, timestamp, prompt, { replacementForPrunedContext })
		: buildWorkspaceProjectionMessage(workspace, timestamp, prompt, { replacementForPrunedContext });
	return message ? [message] : [];
}

function buildPromptQuery(messages: AgentMessage[]): string | undefined {
	let latestPrompt: string | undefined;
	for (const message of messages) {
		if (message.role === "user") latestPrompt = extractMessageText(message.content).trim();
	}
	return latestPrompt;
}

function applyDeterministicCompiledMode(
	messages: AgentMessage[],
	workspace: RlmWorkspace | null | undefined,
	activeContextSummary: string | undefined,
	prompt: string | undefined,
	externalizationKernel?: RlmExternalizationKernelMode,
): RlmRetentionResult | undefined {
	const summaryMessages = messages.filter(isSummaryMessage);
	const summaryPrelude = summaryMessages.length > 0 ? [summaryMessages[summaryMessages.length - 1]] : [];
	const { turns } = buildTurns(messages);
	if (turns.length === 0) {
		const timestamp = messages[messages.length - 1]?.timestamp ?? Date.now();
		const retainedMessages = [
			...summaryPrelude,
			...buildProjectionPrelude(workspace, timestamp, prompt, externalizationKernel, false),
		];
		return {
			messages: retainedMessages,
			metrics: {
				version: 1,
				keptMessages: retainedMessages.length,
				prunedMessages: Math.max(messages.length - retainedMessages.length, 0),
				placeholderMessages: retainedMessages.length > 0 ? 1 : 0,
				retainedTurns: 0,
				prunedTurns: 0,
				...(activeContextSummary ? { activeContextSummary } : {}),
			},
		};
	}

	const latestTurn = turns[turns.length - 1];
	const retainedTurnIndexes = new Set<number>([latestTurn.index]);
	for (const turn of turns) {
		if (turn.hasErrorTool) retainedTurnIndexes.add(turn.index);
	}
	const projectionTimestamp = latestTurn.messages[0]?.timestamp ?? messages[messages.length - 1]?.timestamp ?? Date.now();
	const retainedMessages: AgentMessage[] = [
		...summaryPrelude,
		...buildProjectionPrelude(workspace, projectionTimestamp, prompt, externalizationKernel, turns.length > retainedTurnIndexes.size),
	];
	for (const turn of turns) {
		if (!retainedTurnIndexes.has(turn.index)) continue;
		retainedMessages.push(...turn.messages);
	}
	const prunedTurns = Math.max(turns.length - retainedTurnIndexes.size, 0);
	return {
		messages: retainedMessages,
		metrics: {
			version: 1,
			keptMessages: retainedMessages.length,
			prunedMessages: Math.max(messages.length - retainedMessages.length, 0),
			placeholderMessages: retainedMessages.length > 0 ? 1 : 0,
			retainedTurns: retainedTurnIndexes.size,
			prunedTurns,
			...(activeContextSummary ? { activeContextSummary } : {}),
		},
	};
}

export function buildRetentionCompactionSummary(
	workspace: RlmWorkspace | null | undefined,
	preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
		previousSummary?: string;
		tokensBefore: number;
		firstKeptEntryId: string;
	},
): string {
	const activeContextSummary = buildWorkspaceWorkingSetSummary(workspace);
	const pointerHints = buildWorkspacePointerHints(workspace);
	const lines = [
		"RLM context compacted into durable workspace state.",
		`Summarized messages: ${preparation.messagesToSummarize.length}`,
		`Kept turn prefix messages: ${preparation.turnPrefixMessages.length}`,
		`Tokens before compaction: ${preparation.tokensBefore}`,
		`First kept entry: ${preparation.firstKeptEntryId}`,
	];
	if (activeContextSummary) lines.push("", "Working set:", activeContextSummary);
	if (pointerHints) lines.push("", "Pointers:", pointerHints);
	if (preparation.previousSummary?.trim()) lines.push("", "Previous compaction summary:", trimForSummary(preparation.previousSummary) ?? preparation.previousSummary.trim());
	return lines.join("\n");
}

export function applyRetentionPolicy(
	messages: AgentMessage[],
	options: {
		workspace?: RlmWorkspace | null;
		policy?: Partial<RlmRetentionPolicy>;
		currentTurnIndex?: number;
		externalizationKernel?: RlmExternalizationKernelMode;
	} = {},
): RlmRetentionResult {
	const workspace = options.workspace ? ({ ...options.workspace } as RlmWorkspace) : options.workspace;
	const activeContextSummary = buildWorkspaceWorkingSetSummary(workspace);
	const cleanedMessages = messages.filter((message) => !isLegacyRlmContextMessage(message));
	const latestPrompt = buildPromptQuery(cleanedMessages);
	return applyDeterministicCompiledMode(
		cleanedMessages,
		workspace,
		activeContextSummary,
		latestPrompt,
		options.externalizationKernel,
	) ?? {
		messages: cleanedMessages,
		metrics: {
			version: 1,
			keptMessages: cleanedMessages.length,
			prunedMessages: 0,
			placeholderMessages: 0,
			retainedTurns: 0,
			prunedTurns: 0,
			...(activeContextSummary ? { activeContextSummary } : {}),
		},
	};
}
