import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createRlmExtensionFactory } from "./src/install.js";
import type { RlmExtensionOptions } from "./src/types.js";

export * from "./src/types.js";
export { createRlmExtensionFactory } from "./src/install.js";

export function createRlmExtension(options: RlmExtensionOptions = {}): ExtensionFactory {
	return createRlmExtensionFactory({
		depth: 0,
		maxDepth: options.maxDepth ?? 2,
		root: true,
		profile: options.profile,
		profiles: options.profiles,
		profileConfigPath: options.profileConfigPath,
		externalizationKernel: options.externalizationKernel,
	});
}

export default function rlmExtension(pi: ExtensionAPI) {
	return createRlmExtension()(pi);
}
