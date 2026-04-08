import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildWorkspacePointerHints, buildWorkspaceWorkingSetSummary } from "./workspace.js";
import type { RlmLease, RlmRetentionMetrics, RlmRetentionPolicy, RlmWorkspace } from "./types.js";

export const RLM_RETENTION_TYPE = "rlm-retention";

export const DEFAULT_RLM_RETENTION_POLICY: RlmRetentionPolicy = {
	keepRecentUserTurns: 2,
	keepRecentAssistantTurns: 1,
	keepRecentToolTurns: 1,
	expireConsolidatedAfterTurns: 2,
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

function buildPlaceholderMessage(timestamp: number): AgentMessage {
	return {
		role: "user",
		content:
			"Earlier RLM context was consolidated into globalThis.workspace.activeContext. Inspect globalThis.workspace for durable state instead of replaying old transcript history.",
		timestamp,
	};
}

function countUserTurns(messages: AgentMessage[]): number {
	let turnIndex = -1;
	for (const message of messages) {
		if (isSummaryMessage(message) || isLegacyRlmContextMessage(message)) continue;
		if (message.role === "user") turnIndex += 1;
	}
	return Math.max(turnIndex + 1, 0);
}

function trimForSummary(text: string, maxLength = 1200): string {
	const normalized = text.trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
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
	if (activeContextSummary) {
		lines.push("", "Working set:", activeContextSummary);
	}
	if (pointerHints) {
		lines.push("", "Pointers:", pointerHints);
	}
	if (preparation.previousSummary?.trim()) {
		lines.push("", "Previous compaction summary:", trimForSummary(preparation.previousSummary));
	}
	return lines.join("\n");
}

function hashFingerprint(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function buildToolLeaseFingerprint(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult") return undefined;
	const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
	const toolName = (message as { toolName?: unknown }).toolName;
	const isError = (message as { isError?: unknown }).isError === true;
	if (typeof toolCallId !== "string" || typeof toolName !== "string") return undefined;
	return hashFingerprint([toolName, toolCallId, isError ? "error" : "ok"].join(":"));
}

function findToolLease(workspace: RlmWorkspace | null | undefined, message: AgentMessage): RlmLease | undefined {
	if (!workspace || message.role !== "toolResult") return undefined;
	const fingerprint = buildToolLeaseFingerprint(message);
	if (!fingerprint) return undefined;
	return workspace.retention?.leases?.find(
		(lease) => lease.source === "tool" && lease.messageFingerprint === fingerprint,
	);
}

function buildToolResultPlaceholder(message: AgentMessage, lease: RlmLease | undefined): AgentMessage {
	const toolMessage = message as Extract<AgentMessage, { role: "toolResult" }>;
	const ref = lease?.consolidatedTo?.[0]?.ref ?? "globalThis.workspace.activeContext";
	const toolName = typeof toolMessage.toolName === "string" ? toolMessage.toolName : "tool";
	return {
		role: "toolResult",
		toolCallId: toolMessage.toolCallId,
		toolName: toolMessage.toolName,
		isError: toolMessage.isError,
		timestamp: toolMessage.timestamp,
		details: toolMessage.details,
		content: [{ type: "text", text: `${toolName} output consolidated into ${ref}. Inspect runtime/workspace instead of replaying prior tool output.` }],
	};
}

function maybeThinToolResultMessage(
	message: AgentMessage,
	workspace: RlmWorkspace | null | undefined,
	currentTurnIndex: number,
): AgentMessage {
	if (message.role !== "toolResult") return message;
	if ((message as { isError?: unknown }).isError === true) return message;
	const lease = findToolLease(workspace, message);
	if (!lease) return message;
	if (lease.turnIndex >= currentTurnIndex) return message;
	if (lease.status !== "consolidated" && lease.status !== "expired") return message;
	return buildToolResultPlaceholder(message, lease);
}

export function applyRetentionPolicy(
	messages: AgentMessage[],
	options: {
		workspace?: RlmWorkspace | null;
		policy?: Partial<RlmRetentionPolicy>;
		currentTurnIndex?: number;
	} = {},
): RlmRetentionResult {
	const policy: RlmRetentionPolicy = {
		...DEFAULT_RLM_RETENTION_POLICY,
		...(options.policy ?? {}),
	};
	const workspace = options.workspace ? ({ ...options.workspace } as RlmWorkspace) : options.workspace;
	const activeContextSummary = buildWorkspaceWorkingSetSummary(workspace);
	const cleanedMessages = messages.filter((message) => !isLegacyRlmContextMessage(message));
	const currentTurnIndex = options.currentTurnIndex ?? Math.max(countUserTurns(cleanedMessages) - 1, 0);
	const summaryMessages = cleanedMessages.filter(isSummaryMessage);
	const summaryPrelude = policy.keepLatestSurfaceSummary ? (summaryMessages.length > 0 ? [summaryMessages[summaryMessages.length - 1]] : []) : summaryMessages;
	const turns: Array<{
		index: number;
		hasAssistant: boolean;
		hasTool: boolean;
		hasErrorTool: boolean;
	}> = [];
	const prelude: AgentMessage[] = [];
	let turnIndex = -1;

	for (const message of cleanedMessages) {
		if (isSummaryMessage(message)) continue;
		if (message.role === "user") {
			turnIndex += 1;
			turns.push({ index: turnIndex, hasAssistant: false, hasTool: false, hasErrorTool: false });
		}
		if (turnIndex < 0) {
			prelude.push(message);
			continue;
		}
		const current = turns[turns.length - 1];
		if (!current) continue;
		if (message.role === "assistant") current.hasAssistant = true;
		if (message.role === "toolResult") {
			current.hasTool = true;
			const isError = (message as { isError?: boolean }).isError === true;
			if (isError) current.hasErrorTool = true;
		}
	}

	const keepTurns = new Set<number>();
	const addLast = (values: number[], count: number) => {
		if (count <= 0) return;
		values.slice(-count).forEach((value) => keepTurns.add(value));
	};
	const userTurnIndexes = turns.map((turn) => turn.index);
	const keepUserCount = Math.max(1, policy.keepRecentUserTurns, policy.expireConsolidatedAfterTurns);
	addLast(userTurnIndexes, keepUserCount);
	addLast(
		turns.filter((turn) => turn.hasAssistant).map((turn) => turn.index),
		policy.keepRecentAssistantTurns,
	);
	addLast(
		turns.filter((turn) => turn.hasTool).map((turn) => turn.index),
		policy.keepRecentToolTurns,
	);
	if (policy.keepUnresolvedToolFlows) {
		turns.filter((turn) => turn.hasErrorTool).forEach((turn) => keepTurns.add(turn.index));
	}
	if (keepTurns.size === 0 && turns.length > 0) keepTurns.add(turns[turns.length - 1].index);

	const retainedPrelude: AgentMessage[] = [...summaryPrelude, ...prelude];
	const retainedTurnMessages: AgentMessage[] = [];
	const prunedTurnIndexes = new Set<number>();
	turnIndex = -1;

	for (const message of cleanedMessages) {
		if (isSummaryMessage(message)) continue;
		if (message.role === "user") turnIndex += 1;
		if (turnIndex < 0) continue;
		if (keepTurns.has(turnIndex)) retainedTurnMessages.push(maybeThinToolResultMessage(message, workspace, currentTurnIndex));
		else prunedTurnIndexes.add(turnIndex);
	}

	const retainedMessages: AgentMessage[] = [...retainedPrelude];
	let placeholderMessages = 0;
	if (prunedTurnIndexes.size > 0 && policy.replaceExpiredWithReference) {
		const placeholderTimestamp = retainedTurnMessages[0]?.timestamp ?? retainedPrelude[retainedPrelude.length - 1]?.timestamp ?? Date.now();
		retainedMessages.push(buildPlaceholderMessage(placeholderTimestamp));
		placeholderMessages = 1;
	}
	retainedMessages.push(...retainedTurnMessages);

	const keptMessages = retainedMessages.length;
	const prunedMessages = Math.max(cleanedMessages.length - keptMessages, 0);
	const retainedTurns = turns.filter((turn) => keepTurns.has(turn.index)).length;
	const prunedTurns = Math.max(turns.length - retainedTurns, 0);

	return {
		messages: retainedMessages,
		metrics: {
			version: 1,
			keptMessages,
			prunedMessages,
			placeholderMessages,
			retainedTurns,
			prunedTurns,
			...(activeContextSummary ? { activeContextSummary } : {}),
		},
	};
}
