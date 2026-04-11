export type RlmCommandAction =
	| { type: "toggle" }
	| { type: "set-profile"; profile: string }
	| { type: "list-profiles" }
	| { type: "add-profile"; profile: string; value: string }
	| { type: "clone-profile"; sourceProfile: string; profile: string }
	| { type: "remove-profile"; profile: string }
	| { type: "inspect-profile"; profile?: string }
	| { type: "profile-menu" }
	| { type: "inspect" }
	| { type: "reset" }
	| { type: "invalid"; value: string };

export function parseRlmCommandAction(input: string): RlmCommandAction {
	const trimmed = input.trim();
	if (!trimmed) return { type: "toggle" };
	const lower = trimmed.toLowerCase();
	if (lower === "inspect") return { type: "inspect" };
	if (lower === "reset") return { type: "reset" };
	if (lower === "profile") return { type: "profile-menu" };
	if (lower === "profile list") return { type: "list-profiles" };
	const profilePrefixMatch = trimmed.match(/^\s*profile\s+(.*)$/i);
	if (!profilePrefixMatch) return { type: "invalid", value: trimmed };
	const profileArg = profilePrefixMatch[1]?.trim();
	if (!profileArg) return { type: "profile-menu" };

	const addMatch = profileArg.match(/^add\s+([^\s]+)\s+([\s\S]+)$/i);
	if (addMatch) return { type: "add-profile", profile: addMatch[1], value: addMatch[2].trim() };

	const cloneMatch = profileArg.match(/^clone\s+([^\s]+)\s+([^\s]+)$/i);
	if (cloneMatch) return { type: "clone-profile", sourceProfile: cloneMatch[1], profile: cloneMatch[2] };

	const removeMatch = profileArg.match(/^remove\s+([^\s]+)$/i);
	if (removeMatch) return { type: "remove-profile", profile: removeMatch[1] };

	const maybeList = profileArg.match(/^list$/i);
	if (maybeList) return { type: "list-profiles" };

	const setMatch = profileArg.match(/^set\s+([\s\S]+)$/i);
	if (setMatch) {
		const profileName = setMatch[1].trim();
		if (profileName) return { type: "set-profile", profile: profileName };
		return { type: "invalid", value: trimmed };
	}

	const inspectProfileMatch = profileArg.match(/^((?:show|inspect|info))(?:\s+([\s\S]+))?$/i);
	if (inspectProfileMatch) {
		const profile = inspectProfileMatch[2]?.trim();
		return { type: "inspect-profile", profile };
	}

	return { type: "set-profile", profile: profileArg };
}
