import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("stats prints the model, context capacity, and cumulative token breakdown", async (t) => {
	const controlled = controlStats(t, ["stats", "session-1"], jsonResponse(snapshot()));

	await run();

	assert.equal(
		controlled.stdout.join(""),
		[
			"Session: session-1",
			"Model: openai/gpt-5.4-mini",
			"Context: 68,000 / 272,000 tokens (25.0%)",
			"Cumulative:",
			"  Input: 100,000",
			"  Output: 20,000",
			"  Cache read: 30,000",
			"  Cache write: 4,000",
			"  Reasoning: 5,000",
			"  Total: 154,000",
			"",
		].join("\n"),
	);
	assert.equal(controlled.stderr.join(""), "");
});

test("stats defaults to the latest session for the current directory", async (t) => {
	const controlled = controlStats(t, ["stats"], jsonResponse(snapshot()));

	await run();

	assert.deepEqual(controlled.paths, ["/health", "/sessions", "/health", "/sessions/session-1"]);
	assert.match(controlled.stdout.join(""), /^Session: session-1\n/);
	assert.equal(controlled.stderr.join(""), "");
});

test("stats JSON emits only the session, model, and usage snapshot", async (t) => {
	const current = snapshot();
	const controlled = controlStats(t, ["--json", "stats", "session-1"], jsonResponse(current));

	await run();

	assert.deepEqual(JSON.parse(controlled.stdout.join("")), {
		session: current.session,
		model: current.model,
		usage: current.usage,
	});
});

test("stats reports missing and unreadable sessions", async (t) => {
	await t.test("missing", async (t) => {
		const controlled = controlStats(t, ["stats", "missing"], jsonResponse({}, 404));
		await run();
		assert.equal(controlled.stderr.join(""), "ker: session missing was not found\n");
		assert.equal(process.exitCode, 1);
	});
	await t.test("unreadable", async (t) => {
		const controlled = controlStats(t, ["stats", "broken"], jsonResponse({}, 500));
		await run();
		assert.equal(controlled.stderr.join(""), "ker: session broken is unreadable (HTTP 500)\n");
		assert.equal(process.exitCode, 1);
	});
});

interface ControlledStats {
	paths: string[];
	stderr: string[];
	stdout: string[];
}

function controlStats(t: TestContext, args: string[], response: Response): ControlledStats {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const paths: string[] = [];
	const stderr: string[] = [];
	const stdout: string[] = [];

	process.argv = [process.execPath, "ker", ...args];
	process.exitCode = undefined;
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	});
	globalThis.fetch = async (input): Promise<Response> => {
		const path = new URL(String(input)).pathname;
		paths.push(path);
		if (path === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION });
		if (path === "/sessions") {
			return jsonResponse({ sessions: [snapshot().session], unreadable: [] });
		}
		if (path.startsWith("/sessions/")) return response;
		throw new Error(`Unexpected request to ${path}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});
	return { paths, stderr, stdout };
}

function snapshot(): Protocol.SessionSnapshot {
	return {
		session: {
			id: "session-1",
			cwd: "/project",
			projectRoot: "/project",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		model: {
			provider: "openai",
			id: "gpt-5.4-mini",
			contextWindow: 272_000,
			maxOutputTokens: 128_000,
		},
		usage: {
			contextTokens: 68_000,
			cumulative: {
				input: 100_000,
				output: 20_000,
				cacheRead: 30_000,
				cacheWrite: 4_000,
				reasoning: 5_000,
				total: 154_000,
			},
		},
		entries: [],
		messages: [],
		turns: [],
		queue: { revision: 0, waiting: [] },
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function jsonResponse(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
