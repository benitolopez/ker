import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("cancel targets the captured running turn and supports JSON output", async (t) => {
	const controlled = controlCancel(
		t,
		["--json", "cancel", "session-1"],
		snapshot(queue()),
		jsonResponse({ status: "cancelling", sessionId: "session-1", turnId: "turn-1" }, 202),
	);

	await run();

	assert.deepEqual(controlled.paths, ["/health", "/sessions/session-1", "/sessions/session-1/turns/turn-1/cancel"]);
	assert.deepEqual(JSON.parse(controlled.stdout.join("")) as Protocol.TurnCancellationResult, {
		status: "cancelling",
		sessionId: "session-1",
		turnId: "turn-1",
	});
	assert.equal(controlled.stderr.join(""), "");
});

test("cancel reports an idle queue without sending a request", async (t) => {
	const controlled = controlCancel(t, ["cancel", "session-1"], snapshot({ revision: 4, waiting: [] }));

	await run();

	assert.deepEqual(controlled.paths, ["/health", "/sessions/session-1"]);
	assert.equal(controlled.stderr.join(""), "ker: session session-1 has no running turn to cancel\n");
	assert.equal(process.exitCode, 1);
});

test("cancel does not chase a successor after its captured target goes stale", async (t) => {
	const controlled = controlCancel(
		t,
		["cancel", "session-1"],
		snapshot(queue()),
		jsonResponse({ code: "turn_unavailable" }, 409),
	);

	await run();

	assert.deepEqual(controlled.paths, ["/health", "/sessions/session-1", "/sessions/session-1/turns/turn-1/cancel"]);
	assert.equal(controlled.stderr.join(""), "ker: turn turn-1 is no longer cancellable\n");
	assert.equal(process.exitCode, 1);
});

test("cancel exits nonzero for missing and unreadable sessions", async (t) => {
	await t.test("missing", async (t) => {
		const controlled = controlCancel(t, ["cancel", "session-1"], jsonResponse({}, 404));
		await run();
		assert.equal(controlled.stderr.join(""), "ker: session session-1 was not found\n");
		assert.equal(process.exitCode, 1);
	});
	await t.test("unreadable", async (t) => {
		const controlled = controlCancel(t, ["cancel", "session-1"], jsonResponse({}, 500));
		await run();
		assert.equal(controlled.stderr.join(""), "ker: session session-1 is unreadable (HTTP 500)\n");
		assert.equal(process.exitCode, 1);
	});
});

interface ControlledCancel {
	paths: string[];
	stderr: string[];
	stdout: string[];
}

function controlCancel(
	t: TestContext,
	args: string[],
	sessionSnapshot: Protocol.SessionSnapshot | Response,
	cancellationResponse?: Response,
): ControlledCancel {
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
		if (path === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION }, 200);
		if (path === "/sessions/session-1") {
			return sessionSnapshot instanceof Response ? sessionSnapshot : jsonResponse(sessionSnapshot, 200);
		}
		if (path === "/sessions/session-1/turns/turn-1/cancel" && cancellationResponse) {
			return cancellationResponse;
		}
		throw new Error(`Unexpected request to ${path}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});

	return { paths, stderr, stdout };
}

function queue(): Protocol.QueueSnapshot {
	return {
		revision: 1,
		running: {
			id: "queue-1",
			turnId: "turn-1",
			messageId: "message-1",
			text: "hello",
			state: "running",
			submittedAt: "2026-01-01T00:00:00.000Z",
		},
		waiting: [],
	};
}

function snapshot(queueSnapshot: Protocol.QueueSnapshot): Protocol.SessionSnapshot {
	return {
		session: {
			id: "session-1",
			cwd: "/project",
			projectRoot: "/project",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		entries: [],
		messages: [],
		turns: [],
		queue: queueSnapshot,
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
