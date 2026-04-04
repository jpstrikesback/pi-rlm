import { describe, expect, it } from "vitest";
import {
	buildRlmModeAppendix,
	DEFAULT_RLM_PROMPT_MODE,
	findRlmPromptMode,
	getRlmPromptModeLabel,
	isRlmPromptMode,
} from "../src/prompt-mode.js";

function makeCtx(branch: unknown[]) {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as any;
}

describe("prompt modes", () => {
	it("recognizes valid prompt modes", () => {
		expect(isRlmPromptMode("balanced")).toBe(true);
		expect(isRlmPromptMode("coordinator")).toBe(true);
		expect(isRlmPromptMode("aggressive")).toBe(true);
		expect(isRlmPromptMode("nope")).toBe(false);
	});

	it("returns readable mode labels", () => {
		expect(getRlmPromptModeLabel("balanced")).toBe("BALANCED");
		expect(getRlmPromptModeLabel("coordinator")).toBe("COORDINATOR");
		expect(getRlmPromptModeLabel("aggressive")).toBe("AGGRESSIVE");
	});

	it("finds the latest persisted prompt mode", () => {
		const ctx = makeCtx([
			{ type: "custom", customType: "rlm-prompt-mode", data: { mode: "balanced" } },
			{ type: "custom", customType: "rlm-prompt-mode", data: { mode: "coordinator" } },
		]);

		expect(findRlmPromptMode(ctx)).toBe("coordinator");
	});

	it("falls back to the default prompt mode", () => {
		expect(findRlmPromptMode(makeCtx([]))).toBe(DEFAULT_RLM_PROMPT_MODE);
	});

	it("builds a coordinator appendix that pushes root coordination", () => {
		const appendix = buildRlmModeAppendix("coordinator");
		expect(appendix).toContain("top-level coordinator");
		expect(appendix).toContain("Start in rlm_exec");
		expect(appendix).toContain("Use direct Pi tools as leaf actions");
	});

	it("builds an aggressive appendix that pushes runtime-first behavior", () => {
		const appendix = buildRlmModeAppendix("aggressive");
		expect(appendix).toContain("Unless the task is clearly a one-shot");
		expect(appendix).toContain("globalThis.goal");
		expect(appendix).toContain("not a stateless tool caller");
	});
});
