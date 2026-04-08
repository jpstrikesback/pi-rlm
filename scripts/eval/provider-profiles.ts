export type EvalProviderProfileId = "mlx" | "openai-chat" | "openai-responses";

export type EvalProviderProfile = {
	id: EvalProviderProfileId;
	label: string;
	providerName: string;
	authProviderCandidates?: string[];
};

const PROFILES: Record<EvalProviderProfileId, EvalProviderProfile> = {
	mlx: {
		id: "mlx",
		label: "MLX chat/completions",
		providerName: "eval-mlx",
	},
	"openai-chat": {
		id: "openai-chat",
		label: "OpenAI chat/completions",
		providerName: "openai",
		authProviderCandidates: ["openai", "openai-codex"],
	},
	"openai-responses": {
		id: "openai-responses",
		label: "OpenAI responses",
		providerName: "openai",
		authProviderCandidates: ["openai", "openai-codex"],
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
