import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("cancel targets the captured running turn and supports JSON output", async (t) => {
	const controlled = controlCancel(
		t,
		["--json", "cancel"],
		queue(),
		jsonResponse({ status: "cancelling", sessionId: "session-1", turnId: "turn-1" }, 202),
	);

	await run();

	assert.deepEqual(controlled.paths, ["/health", "/queue", "/sessions/session-1/turns/turn-1/cancel"]);
	assert.deepEqual(JSON.parse(controlled.stdout.join("")) as Protocol.TurnCancellationResult, {
		status: "cancelling",
		sessionId: "session-1",
		turnId: "turn-1",
	});
	assert.equal(controlled.stderr.join(""), "");
});

test("cancel reports an idle queue without sending a request", async (t) => {
	const controlled = controlCancel(t, ["cancel"], { revision: 4, waiting: [] });

	await run();

	assert.deepEqual(controlled.paths, ["/health", "/queue"]);
	assert.equal(controlled.stderr.join(""), "ker: no running turn to cancel\n");
	assert.equal(process.exitCode, 1);
});

test("cancel does not chase a successor after its captured target goes stale", async (t) => {
	const controlled = controlCancel(t, ["cancel"], queue(), jsonResponse({ code: "turn_unavailable" }, 409));

	await run();

	assert.deepEqual(controlled.paths, ["/health", "/queue", "/sessions/session-1/turns/turn-1/cancel"]);
	assert.equal(controlled.stderr.join(""), "ker: turn turn-1 is no longer cancellable\n");
	assert.equal(process.exitCode, 1);
});

interface ControlledCancel {
	paths: string[];
	stderr: string[];
	stdout: string[];
}

function controlCancel(
	t: TestContext,
	args: string[],
	projectQueue: Protocol.ProjectQueueSnapshot,
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
		if (path === "/queue") return jsonResponse(projectQueue, 200);
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

function queue(): Protocol.ProjectQueueSnapshot {
	return {
		revision: 1,
		running: {
			id: "queue-1",
			sessionId: "session-1",
			turnId: "turn-1",
			messageId: "message-1",
			text: "hello",
			state: "running",
			submittedAt: "2026-01-01T00:00:00.000Z",
		},
		waiting: [],
	};
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
