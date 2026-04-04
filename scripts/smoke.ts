import { RuntimeSession } from "../src/runtime.js";
import { buildChildPrompt, normalizeLlmQueryInput, parseChildResult } from "../src/llm-query.js";

async function main() {
	const normalized = normalizeLlmQueryInput({
		prompt: "Analyze a small slice of state",
		role: "scout",
		state: { files: ["a.ts", "b.ts"] },
		tools: "read-only",
		budget: "low",
		output: { mode: "json", schema: { summary: "string", relevantFiles: "string[]" } },
	});

	if (normalized.budget.maxTurns !== 3) throw new Error("Budget preset normalization failed");
	if (normalized.output.mode !== "json") throw new Error("Output normalization failed");

	const prompt = buildChildPrompt(normalized);
	if (!prompt.includes("Role: scout")) throw new Error("Prompt did not include role");

	const parsed = parseChildResult('{"summary":"ok","relevantFiles":["a.ts"]}', normalized, 2);
	if (!parsed.ok || parsed.data?.summary !== "ok") throw new Error("JSON child result parsing failed");

	const runtime = new RuntimeSession();
	try {
		const result = await runtime.exec(
			`
			globalThis.seed = 41;
			const child = await llmQuery({
				prompt: "increment the number",
				role: "worker",
				state: { n: globalThis.seed },
				output: { mode: "json", schema: { value: "number", summary: "string" } }
			});
			globalThis.child = child;
			globalThis.answer = child.data.value;
			console.log("child ok", child.ok, "value", child.data.value);
			final(child.data.value);
			`,
			{
				llmQuery: async (input) => {
					const normalizedInput = normalizeLlmQueryInput(input);
					if (normalizedInput.prompt !== "increment the number") throw new Error("Incorrect prompt passed to llmQuery");
					const n = Number((normalizedInput.state as { n?: number } | undefined)?.n ?? 0);
					return {
						ok: true,
						answer: JSON.stringify({ value: n + 1, summary: "incremented" }),
						summary: "incremented",
						data: { value: n + 1, summary: "incremented" },
						role: normalizedInput.role,
						usage: { turns: 1 },
					};
				},
			},
		);

		if (!result.ok) throw new Error(result.error || "Runtime execution failed");
		if (result.finalValue !== 42) throw new Error(`Expected finalValue 42, got ${String(result.finalValue)}`);
		const inspection = await runtime.inspect();
		if (!inspection.table.includes("answer")) throw new Error("Runtime inspection missing persisted answer");
		console.log("Smoke test passed.");
		console.log(result.stdout);
		console.log(inspection.table);
	} finally {
		await runtime.dispose();
	}
}

await main();
