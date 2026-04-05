import { afterEach, describe, expect, it } from "vitest";
import { RuntimeSession } from "../src/runtime.js";

const runtimes: RuntimeSession[] = [];

function createRuntime() {
	const runtime = new RuntimeSession();
	runtimes.push(runtime);
	return runtime;
}

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("RuntimeSession", () => {
	it("persists values written to globalThis across exec calls", async () => {
		const runtime = createRuntime();

		const first = await runtime.exec("globalThis.count = 41;");
		expect(first.ok).toBe(true);

		const second = await runtime.exec("final(globalThis.count + 1);");
		expect(second.ok).toBe(true);
		expect(second.finalValue).toBe(42);
	});

	it("does not persist local variables that are not written to globalThis", async () => {
		const runtime = createRuntime();

		await runtime.exec("const hidden = 42;");
		const result = await runtime.exec('final("hidden" in globalThis);');

		expect(result.finalValue).toBe(false);
	});

	it("returns finalValue separately from the function return value", async () => {
		const runtime = createRuntime();

		const result = await runtime.exec("final({ answer: 42 }); return 'done';");

		expect(result.ok).toBe(true);
		expect(result.finalValue).toEqual({ answer: 42 });
		expect(result.returnValuePreview).toBe("done");
	});

	it("resets persisted globals", async () => {
		const runtime = createRuntime();

		await runtime.exec("globalThis.answer = 42;");
		await runtime.reset();
		const inspection = await runtime.inspect();

		expect(inspection.table).toBe("(runtime empty)");
	});

	it("restores a snapshot into a fresh runtime", async () => {
		const runtimeA = createRuntime();
		await runtimeA.exec("globalThis.answer = 42; globalThis.items = [1, 2, 3];");
		const snapshot = runtimeA.getSnapshot();

		const runtimeB = createRuntime();
		await runtimeB.restore(snapshot);
		const result = await runtimeB.exec("final({ answer: globalThis.answer, size: globalThis.items.length });");

		expect(result.finalValue).toEqual({ answer: 42, size: 3 });
	});

	it("persists only structured-cloneable globals", async () => {
		const runtime = createRuntime();
		await runtime.exec("globalThis.ok = 42; globalThis.fn = () => 1;");

		const inspection = await runtime.inspect();
		const snapshot = runtime.getSnapshot();

		expect(inspection.table).toContain("ok");
		expect(inspection.table).not.toContain("fn");
		expect(snapshot.bindings).toEqual({ ok: 42 });
	});

	it("does not persist reserved helper globals as user bindings", async () => {
		const runtime = createRuntime();
		await runtime.exec("globalThis.answer = 42;");
		const inspection = await runtime.inspect();

		expect(inspection.table).toContain("answer");
		expect(inspection.table).not.toContain("inspectGlobals");
		expect(inspection.table).not.toContain("llmQuery");
		expect(inspection.table).not.toContain("final");
	});

	it("wires llmQuery through the runtime hook", async () => {
		const runtime = createRuntime();

		const result = await runtime.exec(
			`
			const child = await llmQuery({ prompt: "increment", output: { mode: "json" } });
			globalThis.child = child;
			final(child.data.value);
			`,
			{
				llmQuery: async (input) => {
					expect(input.prompt).toBe("increment");
					return {
						ok: true,
						answer: JSON.stringify({ value: 42, summary: "done" }),
						summary: "done",
						data: { value: 42, summary: "done" },
						usage: { turns: 1 },
					};
				},
			},
		);

		expect(result.ok).toBe(true);
		expect(result.finalValue).toBe(42);
		const inspection = await runtime.inspect();
		expect(inspection.table).toContain("child");
	});

	it("records internal child artifacts into workspace while hiding them from child results", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec(
			`
			globalThis.workspace = { goal: "refactor" };
			const child = await llmQuery({ prompt: "scan auth", output: { mode: "json" } });
			final({
				hasInternal: Object.prototype.hasOwnProperty.call(child, "__rlmInternal"),
				artifactCount: globalThis.workspace.childArtifacts.length,
				lastSummary: globalThis.workspace.lastChildArtifact.summary,
				childSummary: child.summary,
			});
			`,
			{
				llmQuery: async () => ({
					ok: true,
					answer: JSON.stringify({ summary: "child done", value: 1 }),
					summary: "child done",
					data: { summary: "child done", value: 1 },
					usage: { turns: 2 },
					__rlmInternal: {
						childArtifact: {
							version: 1,
							childId: "child-1",
							role: "scout",
							depth: 1,
							turns: 2,
							status: "ok",
							prompt: "scan auth",
							answer: '{"summary":"child done","value":1}',
							summary: "child done",
							data: { summary: "child done", value: 1 },
						},
					},
				} as any),
			},
		);

		expect(result.ok).toBe(true);
		expect(result.finalValue).toEqual({
			hasInternal: false,
			artifactCount: 1,
			lastSummary: "child done",
			childSummary: "child done",
		});
	});

	it("returns execution errors without losing finalValue if final was already set", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec("final(42); throw new Error('boom');");

		expect(result.ok).toBe(false);
		expect(result.error).toContain("boom");
		expect(result.finalValue).toBe(42);
	});
});
