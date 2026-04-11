import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	buildProfileExecCodeParamDescription,
	buildProfileExecGuidelines,
	buildProfileExecPromptSnippet,
	buildProfileGuidance,
	DEFAULT_PROFILE_NAME,
	loadRlmProfileConfigFromPath,
	builtinProfiles,
	findRlmProfileFromBranch,
	materializeProfilePromptOverrides,
	mergeProfiles,
	resolveProfile,
	resolveRlmProfileConfigPathForWrite,
	resolveRlmProfileConfigPaths,
	validateProfileSelectors,
} from "../src/profiles.js";

function makeCtx(branch: unknown[]) {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as any;
}

describe("RLM execution profiles", () => {
	it("loads required built-in profile names", () => {
		const profiles = builtinProfiles();
		expect(Object.keys(profiles).sort()).toEqual(
			expect.arrayContaining([
				"openai-5.4-class",
				"inherit-parent-class",
				"mlx-qwopus-class",
				"mlx-qwopus-legacy-dense",
			]),
		);
		expect(profiles[DEFAULT_PROFILE_NAME].name).toBe("openai-5.4-class");
		expect(profiles[DEFAULT_PROFILE_NAME].helpers?.simpleChild?.defaultModel).toBe("openai-codex/gpt-5.4-mini:off");
		expect(profiles[DEFAULT_PROFILE_NAME].behavior.taskFewShotVariant).toBe("artifact-workflow-openai-v1");
		expect(profiles[DEFAULT_PROFILE_NAME].behavior.rootKickoffVariant).toBe("recursive-chain-v1");
	});

	it("falls back to the default profile", () => {
		const profile = resolveProfile(undefined);
		expect(profile.name).toBe(DEFAULT_PROFILE_NAME);
	});

	it("finds the active profile from session history", () => {
		const ctx = makeCtx([
			{ type: "custom", customType: "rlm-profile", data: { profile: "openai-5.4-class" } },
			{ type: "custom", customType: "rlm-profile", data: { profile: "inherit-parent-class" } },
		]);
		expect(findRlmProfileFromBranch(ctx)).toBe("inherit-parent-class");
	});

	it("treats inherit-parent-class as inherit-only child behavior", () => {
		const profile = resolveProfile("inherit-parent-class");
		expect(profile.helpers.simpleChild.defaultModel).toBeUndefined();
		expect(profile.helpers.simpleChild.disabled).toBe(false);
		expect(profile.helpers.recursiveChild.inheritParentByDefault).toBe(true);
	});

	it("propagates profile guidance into runtime helper guidance", () => {
		const profile = resolveProfile("inherit-parent-class");
		const execGuidelines = buildProfileExecGuidelines(profile, { externalizationKernel: "current" });
		const allText = execGuidelines.join("\n");
		expect(allText).toContain("Simple child default: inherit parent via fallback");
		expect(allText).toContain("Recursive child default: inherit parent by default");
		expect(allText).toContain("Workflow mirror (compact):");
		expect(allText).toContain(
			"Artifact tasks: plan -> first pass -> critique -> commit -> revise from stored state -> finalize.",
		);
		expect(allText).not.toContain("Root kickoff mirror:");
	});

	it("branches profile guidance by guidanceVariant", () => {
		const profile = resolveProfile("openai-5.4-class", {
			"openai-5.4-class": {
				name: "openai-5.4-class",
				behavior: {
					guidanceVariant: "recursive-first",
					directToolBias: "high",
					runtimeBias: "high",
					recursiveBias: "high",
				},
				helpers: {
					simpleChild: {},
					recursiveChild: {},
				},
				fallback: {},
			},
		});
		const guidance = buildProfileGuidance(profile, { externalizationKernel: "current" });
		expect(guidance).toContain("Open rlm_exec with high bias");
		expect(guidance).toContain("Prefer calling helper queries as soon as a branchable subproblem is identified.");
	});

	it("injects profile-owned task-family few-shot blocks into root guidance", () => {
		const profile = resolveProfile("openai-5.4-class");
		const guidance = buildProfileGuidance(profile, { externalizationKernel: "current", root: true });
		expect(guidance).toContain("Task-family workflow few-shot (profile-owned, fixed across tasks):");
		expect(guidance).toContain("Loop: decompose -> solve branches -> compose -> review -> recompose.");
		expect(guidance).toContain("Decompose in rlm_exec with one planner rlm_query before the main work.");
		expect(guidance).toContain("After preview or critique, make one reviewer rlm_query before revising.");
		expect(guidance).toContain("Do not let required structure disappear during recomposition.");
	});

	it("injects the root-only recursive kickoff policy for root sessions", () => {
		const profile = resolveProfile("openai-5.4-class");
		const rootGuidance = buildProfileGuidance(profile, { externalizationKernel: "current", root: true });
		const childGuidance = buildProfileGuidance(profile, { externalizationKernel: "current", root: false });
		expect(rootGuidance).toContain("Root kickoff policy:");
		expect(rootGuidance).toContain("Loop: decompose -> solve branches -> compose -> review -> recompose.");
		expect(rootGuidance).toContain("start in rlm_exec and make one planner rlm_query before the main work");
		expect(rootGuidance).toContain("Solve hard branches with rlm_query, use llm_query only for bounded substeps inside a branch");
		expect(rootGuidance).toContain("make one reviewer rlm_query before revising");
		expect(childGuidance).not.toContain("Root kickoff policy:");
	});

	it("injects the root-only recursive kickoff mirror into root exec guidance", () => {
		const profile = resolveProfile("openai-5.4-class");
		const rootExec = buildProfileExecGuidelines(profile, { externalizationKernel: "current", root: true }).join("\n");
		const childExec = buildProfileExecGuidelines(profile, { externalizationKernel: "current", root: false }).join("\n");
		expect(rootExec).toContain("Root kickoff mirror:");
		expect(rootExec).toContain("Loop: decompose -> solve branches -> compose -> review -> recompose.");
		expect(rootExec).toContain("At the start of a nontrivial task, make one planner rlm_query inside rlm_exec before the main work.");
		expect(rootExec).toContain("Use rlm_query for hard branches, llm_query only for bounded substeps, and direct tools for grounded work.");
		expect(rootExec).toContain("make one reviewer rlm_query before revising");
		expect(childExec).not.toContain("Root kickoff mirror:");
	});

	it("supports model-family-specific task-family few-shot variants", () => {
		const profile = resolveProfile("mlx-qwopus-class");
		const guidance = buildProfileGuidance(profile, { externalizationKernel: "current" });
		expect(guidance).toContain("For nontrivial artifact work, enter rlm_exec before drafting the first full artifact.");
		expect(guidance).toContain("only use llm_query or rlm_query when they clearly reduce work.");
	});

	it("restores the legacy-dense exec contract for the MLX legacy profile", () => {
		const profile = resolveProfile("mlx-qwopus-legacy-dense");
		const execGuidelines = buildProfileExecGuidelines(profile, { externalizationKernel: "current", root: true }).join("\n");
		const promptSnippet = buildProfileExecPromptSnippet(profile, { externalizationKernel: "current" });
		const codeParam = buildProfileExecCodeParamDescription(profile, { externalizationKernel: "current" });
		expect(execGuidelines).toContain("Use globalThis.workspace as the main notebook for durable state and globalThis.workspace.activeContext as the current working set");
		expect(execGuidelines).toContain("Child helper calls use these exact forms: llm_query({ prompt, role, state, tools, budget, output }), rlm_query({ prompt, role, state, tools, budget, output }), or llmQuery({ prompt, role, state, tools, budget, output }).");
		expect(execGuidelines).toContain("Tools presets are read-only, coding, same, or an explicit built-in tool list.");
		expect(promptSnippet).toContain("Use this as the persistent coordinator workspace for multi-file or multi-step tasks.");
		expect(promptSnippet).toContain("globalThis.workspace.activeContext");
		expect(codeParam).toContain("Use globalThis.workspace as the durable coordinator notebook and globalThis.workspace.activeContext as the current working set.");
	});

	it("applies prompt overrides only on the non-templated prompt surfaces", () => {
		const profile = resolveProfile("openai-5.4-class", {
			"openai-5.4-class": {
				name: "openai-5.4-class",
				behavior: {
					guidanceVariant: "default",
					taskFewShotVariant: "artifact-workflow-openai-v1",
					rootKickoffVariant: "recursive-chain-v1",
				},
				promptOverrides: {
					rootKickoff: {
						current: { root: "Custom root kickoff", exec: "Custom exec kickoff" },
					},
					taskFewShot: {
						current: { root: "Custom task few-shot", exec: "Custom exec few-shot" },
					},
					execPromptSnippet: {
						current: "Custom exec prompt snippet",
					},
					execCodeParamDescription: {
						current: "Custom code param description",
					},
				},
			},
		});
		expect(buildProfileGuidance(profile, { externalizationKernel: "current", root: true })).toContain("Custom root kickoff");
		expect(buildProfileGuidance(profile, { externalizationKernel: "current", root: true })).toContain("Custom task few-shot");
		expect(buildProfileExecGuidelines(profile, { externalizationKernel: "current", root: true }).join("\n")).toContain("Custom exec kickoff");
		expect(buildProfileExecGuidelines(profile, { externalizationKernel: "current", root: true }).join("\n")).toContain("Custom exec few-shot");
		expect(buildProfileExecPromptSnippet(profile, { externalizationKernel: "current" })).toBe("Custom exec prompt snippet");
		expect(buildProfileExecCodeParamDescription(profile, { externalizationKernel: "current" })).toBe("Custom code param description");
	});

	it("materializes builtin prompt surfaces into prompt overrides for cloning", () => {
		const profile = resolveProfile("openai-5.4-class");
		const overrides = materializeProfilePromptOverrides(profile);
		expect(overrides.rootKickoff?.current?.root).toContain("Root kickoff policy:");
		expect(overrides.rootKickoff?.current?.exec).toContain("Root kickoff mirror:");
		expect(overrides.taskFewShot?.current?.root).toContain("Task-family workflow few-shot");
		expect(overrides.taskFewShot?.current?.exec).toContain("Workflow mirror (compact):");
		expect(overrides.execPromptSnippet?.current).toBe(buildProfileExecPromptSnippet(profile, { externalizationKernel: "current" }));
		expect(overrides.execCodeParamDescription?.current).toBe(
			buildProfileExecCodeParamDescription(profile, { externalizationKernel: "current" }),
		);
	});

	it("validates selectors against the model registry", async () => {
		const profile = resolveProfile("openai-5.4-class");
		const validRegistry = {
			find: (provider: string, id: string) => (provider === "openai-codex" && id === "gpt-5.4-mini" ? {} : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true }),
		};
		await expect(validateProfileSelectors(profile, validRegistry)).resolves.toBeUndefined();

		const missingModelRegistry = {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		};
		await expect(validateProfileSelectors(profile, missingModelRegistry)).rejects.toThrow(/unknown model selector/i);

		const authFailureRegistry = {
			find: () => ({}),
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing creds" }),
		};
		await expect(validateProfileSelectors(profile, authFailureRegistry)).rejects.toThrow(/no usable auth/i);
	});

	it("loads custom profiles from an explicit config file", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-rlm-profiles-"));
		const configPath = join(root, ".pi", "agent", "rlm-config.json");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		try {
			writeFileSync(
				configPath,
				JSON.stringify(
					{
						version: 1,
						profiles: {
							"custom-profile": {
								name: "custom-profile",
								description: "Custom profile for tests",
								behavior: {
									guidanceVariant: "default",
									directToolBias: "low",
								},
							},
						},
					},
					null,
					2,
				),
			);
			const fileProfiles = loadRlmProfileConfigFromPath(configPath);
			expect(fileProfiles["custom-profile"]).toBeTruthy();
			const merged = mergeProfiles(fileProfiles);
			const mergedProfile = resolveProfile("custom-profile", merged);
			expect(mergedProfile.name).toBe("custom-profile");
			expect(mergedProfile.behavior.directToolBias).toBe("low");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("gives explicit config path highest precedence in config resolution order", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-rlm-config-order-"));
		try {
			const explicitPath = join(root, "custom", "profiles.json");
			const paths = resolveRlmProfileConfigPaths(root, explicitPath);
			expect(paths.at(-1)).toBe(explicitPath);
			expect(new Set(paths).size).toBe(paths.length);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes user profile changes to project config by default", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-rlm-config-write-"));
		try {
			const writePath = resolveRlmProfileConfigPathForWrite(root);
			expect(writePath).toBe(join(root, ".pi", "agent", "rlm-config.json"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not treat an empty wrapped profiles object as a profile named profiles", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-rlm-empty-profiles-"));
		const configPath = join(root, ".pi", "agent", "rlm-config.json");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		try {
			writeFileSync(
				configPath,
				JSON.stringify(
					{
						version: 1,
						profiles: {},
					},
					null,
					2,
				),
			);
			const fileProfiles = loadRlmProfileConfigFromPath(configPath);
			expect(Object.keys(fileProfiles)).toEqual([]);
			expect(fileProfiles["profiles"]).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
