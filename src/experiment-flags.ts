import type { RlmExternalizationKernelMode, RlmWorkspace } from "./types.js";
import { hasPendingWorkspaceConsolidation } from "./workspace.js";

function renderBullets(lines: string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

export function buildRoutingLadderBlock(options: {
	externalizationKernel?: RlmExternalizationKernelMode;
	lines?: string[];
} = {}): string {
	const isNoSubcalls = options.externalizationKernel === "no-subcalls";
	const lines = options.lines ?? [
		"Direct Pi tools first for simple grounded work, one-shot lookups, and short read/edit tasks.",
		"Use rlm_exec when the task needs durable state, multi-step coordination, or a working set larger than the transcript should hold.",
		isNoSubcalls
			? "In no-subcalls mode, keep working inside rlm_exec with direct leaf tools and workspace/runtime state; child-query helpers are disabled."
			: "Inside rlm_exec, use llm_query for bounded lightweight side-computation and rlm_query for deeper decomposable subproblems.",
	];
	return `Routing ladder:\n${renderBullets(lines)}`;
}

export function buildRoutingFewShotBlock(options: {
	externalizationKernel?: RlmExternalizationKernelMode;
	doLines?: string[];
	doNotLines?: string[];
	fallbackLines?: string[];
} = {}): string {
	const isNoSubcalls = options.externalizationKernel === "no-subcalls";
	const doLines = options.doLines ?? [
		"Do: for a simple grounded task, stay with direct tools and answer without entering rlm_exec.",
		isNoSubcalls
			? "Do: for a stateful task, enter rlm_exec, use direct leaf tools, keep reusable state in workspace/runtime variables, commit durable findings, then answer."
			: "Do: if the task explicitly asks for llm_query or rlm_query, enter rlm_exec, call those helpers directly, commit the result, then answer.",
	];
	const doNotLines = options.doNotLines ?? [
		isNoSubcalls
			? "Do not replace a simple direct-tool task with repeated rlm_exec probing or unnecessary workspace ceremony."
			: "Do not replace explicitly requested llm_query/rlm_query work with manual repo scanning unless helper execution is actually blocked.",
		"Do not add fs imports, file writes, or .local artifacts inside rlm_exec unless the task explicitly requires them; prefer globalThis.workspace.commit({...}) for durable persistence.",
	];
	const fallbackLines = options.fallbackLines ?? ["If optional runtime code fails, remove it and continue with the core task path."];
	return `Few-shot routing examples:\nDo:\n${renderBullets(doLines)}\nDo not:\n${renderBullets(doNotLines)}\nFallback:\n${renderBullets(fallbackLines)}`;
}

export function buildStaleWorkspacePromptAppendix(workspace: RlmWorkspace | null | undefined): string {
	if (!hasPendingWorkspaceConsolidation(workspace)) return "";
	return "\n\nRLM workspace note: recent leaf-tool output has not yet been consolidated. Return to rlm_exec and call globalThis.workspace.commit({...}) before doing more leaf work or finalizing.";
}

export function buildExecPromptGuidelines(options: {
	externalizationKernel?: RlmExternalizationKernelMode;
	routingLadderBlock?: string;
	routingFewShotBlock?: string;
	profileGuidanceLines?: string[];
}): string[] {
	const isNoSubcalls = options.externalizationKernel === "no-subcalls";
	const fallbackRoutingLadderBlock = buildRoutingLadderBlock(options);
	const fallbackRoutingFewShotBlock = buildRoutingFewShotBlock(options);
	const lines = [
		isNoSubcalls
			? "Use this only when the task needs durable state, direct leaf tools, and long-horizon runtime/workspace coordination. Child-query helpers are disabled in this mode."
			: "Use this only when the task needs durable state, recursive child queries, or long-horizon coordination. Do not use it for simple fact lookups or single-file questions.",
		options.routingLadderBlock ?? fallbackRoutingLadderBlock,
		options.routingFewShotBlock ?? fallbackRoutingFewShotBlock,
		"Inspect globalThis.context first, especially globalThis.context.compiledContext, then inspect globalThis.workspace.activeContext. Treat globalThis.history as metadata-only fallback.",
		"Use globalThis.workspace as the main notebook for durable state and globalThis.workspace.activeContext as the live working set; treat globalThis.context.compiledContext as the deterministic prompt-visible projection of that state.",
		"Prefer globalThis.workspace.commit({ goal, plan, files, findings, openQuestions, partialOutputs }) over ad hoc workspace mutation when you want durable state.",
		...(options.profileGuidanceLines ?? []),
		isNoSubcalls
			? "Use direct Pi tools as leaf actions and runtime variables/workspace as your coordination substrate. Return here to update the workspace."
			: "Use llm_query for simple one-shot extraction or summarization, and rlm_query for deeper recursive work.",
		"REPL output is truncated. Keep large buffers in variables or workspace instead of console output.",
		"After any meaningful leaf-tool burst or reusable finding, return here and call globalThis.workspace.commit({...}) before more leaf work or finalizing.",
	];
	if (!isNoSubcalls) {
		lines.push("Batch independent subtasks instead of many tiny sequential calls.");
	}
	return lines;
}
