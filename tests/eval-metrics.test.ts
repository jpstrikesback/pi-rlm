import { describe, expect, it } from "vitest";
import { canonicalizeProviderPayload, longestCommonPrefixChars, parseMlxUsage, parseProviderUsage, sumUsage } from "../scripts/eval/metrics.js";

describe("eval metrics helpers", () => {
	it("canonicalizes provider payloads with stable key ordering", () => {
		const left = canonicalizeProviderPayload({
			messages: [{ role: "user", content: "hello" }],
			model: "mlx",
			temperature: 0,
			stream: true,
			z: 1,
			a: 2,
		});
		const right = canonicalizeProviderPayload({
			a: 2,
			z: 1,
			stream: true,
			temperature: 0,
			model: "mlx",
			messages: [{ content: "hello", role: "user" }],
		});

		expect(left).toBe(right);
	});

	it("computes longest common prefix", () => {
		expect(longestCommonPrefixChars("abcdef", "abcXYZ")).toBe(3);
		expect(longestCommonPrefixChars("same", "same")).toBe(4);
		expect(longestCommonPrefixChars("", "same")).toBe(0);
	});

	it("parses direct mlx usage payloads", () => {
		const usage = parseMlxUsage(
			JSON.stringify({
				usage: {
					prompt_tokens: 1056,
					completion_tokens: 50,
					total_tokens: 1106,
					prompt_tokens_details: { cached_tokens: 1024 },
				},
			}),
		);

		expect(usage).toEqual({
			promptTokens: 1056,
			completionTokens: 50,
			totalTokens: 1106,
			cacheHitTokens: 1024,
			cacheMissTokens: 32,
		});
	});

	it("parses streamed mlx usage chunks", () => {
		const usage = parseMlxUsage([
			'data: {"choices":[{"delta":{"content":"hi"}}]}',
			'data: {"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_tokens_details":{"cached_tokens":80}}}',
			"data: [DONE]",
		].join("\n"));

		expect(usage).toEqual({
			promptTokens: 100,
			completionTokens: 5,
			totalTokens: 105,
			cacheHitTokens: 80,
			cacheMissTokens: 20,
		});
	});

	it("parses openai responses usage payloads", () => {
		const usage = parseProviderUsage(
			"openai-responses",
			JSON.stringify({
				type: "response.completed",
				response: {
					usage: {
						input_tokens: 1200,
						output_tokens: 75,
						total_tokens: 1275,
						input_tokens_details: { cached_tokens: 1100 },
					},
				},
			}),
		);

		expect(usage).toEqual({
			promptTokens: 1200,
			completionTokens: 75,
			totalTokens: 1275,
			cacheHitTokens: 1100,
			cacheMissTokens: 100,
		});
	});

	it("sums usage across request logs", () => {
		const usage = sumUsage([
			{ usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheHitTokens: 8, cacheMissTokens: 2 } },
			{ usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6, cacheHitTokens: 0, cacheMissTokens: 5 } },
		]);

		expect(usage).toEqual({
			promptTokens: 15,
			completionTokens: 3,
			totalTokens: 18,
			cacheHitTokens: 8,
			cacheMissTokens: 7,
		});
	});
});
