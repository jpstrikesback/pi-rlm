import type { ProxyUsage } from "./types.js";
import { parseProviderUsage } from "./metrics.js";

export type EvalProviderProfileId = "mlx" | "openai-chat" | "openai-responses";

export type EvalProviderProfile = {
	id: EvalProviderProfileId;
	label: string;
	description: string;
	providerName: string;
	authProviderCandidates?: string[];
	api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
	authHeader: boolean;
	defaultUpstreamBaseUrl: string;
	defaultUpstreamEnvVar?: string;
	defaultApiKeyEnvVar?: string;
	usageFormat: "openai-completions" | "openai-responses";
	cacheFieldMapping: {
		promptTokens: string;
		completionTokens: string;
		totalTokens: string;
		cacheHitTokens: string;
		cacheMissTokens: string;
	};
	defaultCompat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
	};
};

const PROFILES: Record<EvalProviderProfileId, EvalProviderProfile> = {
	mlx: {
		id: "mlx",
		label: "MLX chat/completions",
		description: "mlx_lm.server via OpenAI-compatible chat/completions.",
		providerName: "eval-mlx",
		api: "openai-completions",
		authHeader: false,
		defaultUpstreamBaseUrl: "http://127.0.0.1:8080",
		defaultUpstreamEnvVar: "MLX_BASE_URL",
		usageFormat: "openai-completions",
		cacheFieldMapping: {
			promptTokens: "usage.prompt_tokens",
			completionTokens: "usage.completion_tokens",
			totalTokens: "usage.total_tokens",
			cacheHitTokens: "usage.prompt_tokens_details.cached_tokens",
			cacheMissTokens: "usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens",
		},
		defaultCompat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
	},
	"openai-chat": {
		id: "openai-chat",
		label: "OpenAI chat/completions",
		description: "OpenAI-compatible chat/completions provider with standard auth and usage fields.",
		providerName: "openai",
		authProviderCandidates: ["openai", "openai-codex"],
		api: "openai-completions",
		authHeader: true,
		defaultUpstreamBaseUrl: "https://api.openai.com/v1",
		defaultUpstreamEnvVar: "OPENAI_BASE_URL",
		defaultApiKeyEnvVar: "OPENAI_API_KEY",
		usageFormat: "openai-completions",
		cacheFieldMapping: {
			promptTokens: "usage.prompt_tokens",
			completionTokens: "usage.completion_tokens",
			totalTokens: "usage.total_tokens",
			cacheHitTokens: "usage.prompt_tokens_details.cached_tokens",
			cacheMissTokens: "usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens",
		},
	},
	"openai-responses": {
		id: "openai-responses",
		label: "OpenAI responses",
		description: "OpenAI Responses API profile with responses-style usage fields.",
		providerName: "openai",
		authProviderCandidates: ["openai", "openai-codex"],
		api: "openai-responses",
		authHeader: true,
		defaultUpstreamBaseUrl: "https://api.openai.com/v1",
		defaultUpstreamEnvVar: "OPENAI_BASE_URL",
		defaultApiKeyEnvVar: "OPENAI_API_KEY",
		usageFormat: "openai-responses",
		cacheFieldMapping: {
			promptTokens: "usage.input_tokens",
			completionTokens: "usage.output_tokens",
			totalTokens: "usage.total_tokens",
			cacheHitTokens: "usage.input_tokens_details.cached_tokens",
			cacheMissTokens: "usage.input_tokens - usage.input_tokens_details.cached_tokens",
		},
	},
};

export function getProviderProfiles(): EvalProviderProfile[] {
	return Object.values(PROFILES);
}

export function findProviderProfile(id: string | undefined): EvalProviderProfile {
	if (!id) return PROFILES.mlx;
	const profile = PROFILES[id as EvalProviderProfileId];
	if (!profile) {
		throw new Error(`Unknown provider profile: ${id}. Available: ${Object.keys(PROFILES).join(", ")}`);
	}
	return profile;
}

export function resolveUpstreamBaseUrl(profile: EvalProviderProfile, explicit: string | undefined): string {
	if (explicit) return explicit;
	if (profile.defaultUpstreamEnvVar && process.env[profile.defaultUpstreamEnvVar]) {
		return process.env[profile.defaultUpstreamEnvVar] as string;
	}
	return profile.defaultUpstreamBaseUrl;
}

export function resolveApiKeySource(profile: EvalProviderProfile, options: { apiKey?: string; apiKeyEnv?: string }): string | undefined {
	if (options.apiKey) return options.apiKey;
	if (options.apiKeyEnv) return options.apiKeyEnv;
	if (profile.defaultApiKeyEnvVar && process.env[profile.defaultApiKeyEnvVar]) {
		return profile.defaultApiKeyEnvVar;
	}
	return undefined;
}

export function parseUsageForProfile(profile: EvalProviderProfile, responseText: string): ProxyUsage | undefined {
	return parseProviderUsage(profile.usageFormat, responseText);
}
