import type { RlmPromptMode } from "./types.js";

export type RlmCommandAction =
	| { type: "toggle" }
	| { type: "set-mode"; mode: RlmPromptMode }
	| { type: "inspect" }
	| { type: "reset" }
	| { type: "invalid"; value: string };

export function parseRlmCommandAction(input: string): RlmCommandAction {
	const value = input.trim().toLowerCase();
	if (!value) return { type: "toggle" };
	if (value === "balanced" || value === "coordinator" || value === "aggressive") {
		return { type: "set-mode", mode: value };
	}
	if (value === "inspect") return { type: "inspect" };
	if (value === "reset") return { type: "reset" };
	return { type: "invalid", value };
}
