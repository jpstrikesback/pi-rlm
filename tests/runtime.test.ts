import { afterEach, describe, expect, it, vi } from "vitest";
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
		await runtime.exec("globalThis.count = 41;");
		const result = await runtime.exec("final(globalThis.count + 1);");
		expect(result.finalValue).toBe(42);
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

	it("skips restore requests when the snapshot is unchanged", async () => {
		const runtime = createRuntime();
		await runtime.exec("globalThis.answer = 42;");
		const snapshot = structuredClone(runtime.getSnapshot());
		const requestSpy = vi.spyOn(runtime as any, "request");
		await runtime.restore(snapshot);
		expect(requestSpy).not.toHaveBeenCalled();
	});

	it("retries restore once after a failure and updates the snapshot on success", async () => {
		const runtime = createRuntime();
		const snapshot = { version: 1 as const, bindings: { answer: 42 }, entries: [] };
		const requestSpy = vi.spyOn(runtime as any, "request");
		const restartSpy = vi.spyOn(runtime as any, "restart").mockResolvedValue(undefined);
		requestSpy.mockImplementation(async (...args: any[]) => {
			expect(args[2]).toBe(30000);
			if (requestSpy.mock.calls.length === 1) throw new Error("Runtime restore timed out after 30000ms");
			return {
				inspection: { entries: [], table: "" },
				snapshot,
			};
		});
		await runtime.restore(snapshot);
		expect(restartSpy).toHaveBeenCalledTimes(1);
		expect(requestSpy).toHaveBeenCalledTimes(2);
		expect(runtime.getSnapshot()).toEqual(snapshot);
	});

	it("forces restore after restart even when the snapshot matches the last known state", async () => {
		const runtime = createRuntime();
		const snapshot = { version: 1 as const, bindings: { answer: 42 }, entries: [] };
		(runtime as any).lastSnapshot = snapshot;
		const requestSpy = vi.spyOn(runtime as any, "request").mockResolvedValue({
			inspection: { entries: [], table: "" },
			snapshot,
		});
		await (runtime as any).restart(snapshot);
		expect(requestSpy).toHaveBeenCalledTimes(1);
		expect(requestSpy).toHaveBeenCalledWith("restore", { snapshot }, 30000);
	});

	it("forwards live workspace context internally to llmQuery", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec(
			`
			globalThis.workspace = { goal: "refactor", files: ["src/auth.ts"] };
			const child = await llmQuery({ prompt: "increment", output: { mode: "json" } });
			final(child.data.value);
			`,
			{
				llmQuery: async (input: any) => {
					expect(input.prompt).toBe("increment");
					expect(input.__rlmRuntimeContext.workspace.goal).toBe("refactor");
					expect(input.__rlmRuntimeContext.queryMode).toBe("recursive");
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
		expect(result.finalValue).toBe(42);
	});

	it("blocks child-query helpers in no-subcalls mode without inflating executed query counters", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec(
			`try { await llm_query('scan auth'); } catch (error) { final(String(error.message || error)); }`,
			{ externalizationKernel: "no-subcalls" },
		);
		expect(String(result.finalValue)).toContain("disabled");
		expect(result.attemptedSimpleQueryCount).toBe(1);
		expect(result.simpleQueryCount).toBe(0);
		expect(result.recursiveQueryCount).toBe(0);
	});

	it("records workspace commits, workspace state, and runtime binding deltas", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec(
			`
			globalThis.workspace = { goal: 'refactor' };
			globalThis.notes = { touched: ['src/a.ts'] };
			globalThis.workspace.commit({ findings: ['done'], files: ['src/a.ts'] });
			final(globalThis.workspace.findings.length);
			`,
		);
		expect(result.finalValue).toBe(1);
		expect(result.commitCount).toBe(1);
		expect(result.workspaceState?.hasCommitted).toBe(true);
		expect(result.runtimeBindingCountBefore).toBe(0);
		expect((result.runtimeBindingCountAfter ?? 0)).toBeGreaterThanOrEqual(2);
		expect((result.runtimeNewBindingCount ?? 0)).toBeGreaterThanOrEqual(2);
	});
});
