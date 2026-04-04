import { afterEach, describe, expect, it } from "vitest";
import { RuntimeManager } from "../src/runtime.js";

const managers: RuntimeManager[] = [];

function createManager() {
	const manager = new RuntimeManager();
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

describe("RuntimeManager", () => {
	it("returns the same session for the same key", () => {
		const manager = createManager();
		const a = manager.getOrCreate("session-a");
		const b = manager.getOrCreate("session-a");

		expect(a).toBe(b);
	});

	it("returns different sessions for different keys", () => {
		const manager = createManager();
		const a = manager.getOrCreate("session-a");
		const b = manager.getOrCreate("session-b");

		expect(a).not.toBe(b);
	});

	it("dispose removes only the requested session", async () => {
		const manager = createManager();
		const a = manager.getOrCreate("session-a");
		const b = manager.getOrCreate("session-b");

		await manager.dispose("session-a");

		const nextA = manager.getOrCreate("session-a");
		const nextB = manager.getOrCreate("session-b");
		expect(nextA).not.toBe(a);
		expect(nextB).toBe(b);
	});
});
