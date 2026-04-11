import { describe, expect, it } from "vitest";
import { parseRlmCommandAction } from "../src/rlm-command.js";

describe("parseRlmCommandAction", () => {
	it("toggles on empty input", () => {
		expect(parseRlmCommandAction("")).toEqual({ type: "toggle" });
		expect(parseRlmCommandAction("   ")).toEqual({ type: "toggle" });
	});

	it("parses profile changes", () => {
		expect(parseRlmCommandAction("profile openai-5.4-class")).toEqual({ type: "set-profile", profile: "openai-5.4-class" });
		expect(parseRlmCommandAction("profile inherit-parent-class")).toEqual({ type: "set-profile", profile: "inherit-parent-class" });
	});

	it("parses inspect and reset actions", () => {
		expect(parseRlmCommandAction("inspect")).toEqual({ type: "inspect" });
		expect(parseRlmCommandAction("reset")).toEqual({ type: "reset" });
	});

	it("returns invalid for unknown subcommands", () => {
		expect(parseRlmCommandAction("on")).toEqual({ type: "invalid", value: "on" });
		expect(parseRlmCommandAction("prompt profile openai-5.4-class")).toEqual({ type: "invalid", value: "prompt profile openai-5.4-class" });
	});

	it("opens profile menu for profile without args", () => {
		expect(parseRlmCommandAction("profile")).toEqual({ type: "profile-menu" });
	});

	it("parses profile list", () => {
		expect(parseRlmCommandAction("profile list")).toEqual({ type: "list-profiles" });
	});

	it("parses profile add with JSON payload", () => {
		expect(parseRlmCommandAction('profile add my-profile {"name":"my-profile","behavior":{"guidanceVariant":"default"}}')).toEqual({
			type: "add-profile",
			profile: "my-profile",
			value: '{"name":"my-profile","behavior":{"guidanceVariant":"default"}}',
		});
	});

	it("parses profile clone", () => {
		expect(parseRlmCommandAction("profile clone openai-5.4-class my-profile")).toEqual({
			type: "clone-profile",
			sourceProfile: "openai-5.4-class",
			profile: "my-profile",
		});
	});

	it("parses profile remove", () => {
		expect(parseRlmCommandAction("profile remove my-profile")).toEqual({
			type: "remove-profile",
			profile: "my-profile",
		});
	});

	it("parses profile set alias", () => {
		expect(parseRlmCommandAction("profile set my-profile")).toEqual({ type: "set-profile", profile: "my-profile" });
	});

	it("parses profile inspect for active profile", () => {
		expect(parseRlmCommandAction("profile inspect")).toEqual({ type: "inspect-profile", profile: undefined });
	});

	it("parses profile inspect with explicit profile", () => {
		expect(parseRlmCommandAction("profile inspect my-profile")).toEqual({
			type: "inspect-profile",
			profile: "my-profile",
		});
	});

	it("parses profile show alias", () => {
		expect(parseRlmCommandAction("profile show my-profile")).toEqual({
			type: "inspect-profile",
			profile: "my-profile",
		});
	});
});
