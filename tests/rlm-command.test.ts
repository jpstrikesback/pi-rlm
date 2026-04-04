import { describe, expect, it } from "vitest";
import { parseRlmCommandAction } from "../src/rlm-command.js";

describe("parseRlmCommandAction", () => {
	it("toggles on empty input", () => {
		expect(parseRlmCommandAction("")).toEqual({ type: "toggle" });
		expect(parseRlmCommandAction("   ")).toEqual({ type: "toggle" });
	});

	it("parses prompt mode changes", () => {
		expect(parseRlmCommandAction("balanced")).toEqual({ type: "set-mode", mode: "balanced" });
		expect(parseRlmCommandAction("coordinator")).toEqual({ type: "set-mode", mode: "coordinator" });
		expect(parseRlmCommandAction("aggressive")).toEqual({ type: "set-mode", mode: "aggressive" });
	});

	it("parses inspect and reset actions", () => {
		expect(parseRlmCommandAction("inspect")).toEqual({ type: "inspect" });
		expect(parseRlmCommandAction("reset")).toEqual({ type: "reset" });
	});

	it("returns invalid for unknown subcommands", () => {
		expect(parseRlmCommandAction("on")).toEqual({ type: "invalid", value: "on" });
		expect(parseRlmCommandAction("prompt coordinator")).toEqual({ type: "invalid", value: "prompt coordinator" });
	});
});
