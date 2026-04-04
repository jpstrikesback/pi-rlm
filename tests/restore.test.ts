import { describe, expect, it } from "vitest";
import { findBootstrapSnapshot, findLatestSnapshot, getSessionRuntimeKey } from "../src/restore.js";
import type { RuntimeSnapshot } from "../src/types.js";

function makeCtx(sessionId: string, branch: unknown[]) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as any;
}

const snapshotA: RuntimeSnapshot = {
	version: 1,
	bindings: { a: 1 },
	entries: [],
};

const snapshotB: RuntimeSnapshot = {
	version: 1,
	bindings: { b: 2 },
	entries: [],
};

describe("restore helpers", () => {
	it("uses the session id as the runtime key", () => {
		expect(getSessionRuntimeKey(makeCtx("session-123", []))).toBe("session-123");
	});

	it("finds the latest snapshot from rlm_exec or rlm_reset tool results", () => {
		const ctx = makeCtx("session-1", [
			{
				type: "message",
				message: { role: "toolResult", toolName: "rlm_exec", details: { snapshot: snapshotA } },
			},
			{
				type: "message",
				message: { role: "toolResult", toolName: "read", details: {} },
			},
			{
				type: "message",
				message: { role: "toolResult", toolName: "rlm_reset", details: { snapshot: snapshotB } },
			},
		]);

		expect(findLatestSnapshot(ctx)).toEqual(snapshotB);
	});

	it("falls back to the latest custom rlm-runtime snapshot entry", () => {
		const ctx = makeCtx("session-1", [
			{
				type: "custom",
				customType: "rlm-runtime",
				data: { snapshot: snapshotA },
			},
			{
				type: "custom",
				customType: "rlm-runtime",
				data: { snapshot: snapshotB },
			},
		]);

		expect(findLatestSnapshot(ctx)).toEqual(snapshotB);
	});

	it("returns undefined when no snapshots exist", () => {
		const ctx = makeCtx("session-1", [
			{
				type: "message",
				message: { role: "toolResult", toolName: "read", details: {} },
			},
		]);

		expect(findLatestSnapshot(ctx)).toBeUndefined();
	});

	it("builds a bootstrap snapshot from the latest child bootstrap entry", () => {
		const state = { files: ["a.ts", "b.ts"], summary: "auth" };
		const ctx = makeCtx("session-1", [
			{
				type: "custom",
				customType: "rlm-child-bootstrap",
				data: { state: { old: true } },
			},
			{
				type: "custom",
				customType: "rlm-child-bootstrap",
				data: { state },
			},
		]);

		expect(findBootstrapSnapshot(ctx)).toEqual({
			version: 1,
			bindings: {
				input: state,
				parentState: state,
			},
			entries: [],
		});
	});

	it("returns undefined when no child bootstrap entry exists", () => {
		const ctx = makeCtx("session-1", []);
		expect(findBootstrapSnapshot(ctx)).toBeUndefined();
	});
});
