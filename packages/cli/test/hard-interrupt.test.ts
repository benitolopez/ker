import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("a waiting prompt cancelled by SIGINT targets itself and exits 130", async (t) => {
	const controlled = controlPrompt(t, "waiting");
	const running = run();
	await controlled.promptStarted.promise;
	controlled.promptResponse.resolve(jsonResponse(admission("waiting"), 202));
	await waitFor(() => controlled.stderr.join("").includes("ker: waiting"));

	const interrupt = findNewSignalListener(controlled.signalListeners);
	interrupt("SIGINT");
	await running;

	assert.deepEqual(controlled.cancelBodies, [{ sessionId: "session-1", turnId: "turn-1" }]);
	assert.match(controlled.stderr.join(""), /ker: cancelled \(turn turn-1\)/);
	assert.equal(process.exitCode, 130);
});

test("a prompt recovers a missed cancellation from its next snapshot", async (t) => {
	const controlled = controlPrompt(t, "running", [snapshot(), terminalSnapshot("aborted")]);
	const running = run();
	await controlled.promptStarted.promise;
	controlled.promptResponse.resolve(jsonResponse(admission("running"), 202));
	controlled.closeStream();
	await running;

	assert.equal(controlled.stderr.join(""), "ker: aborted (turn turn-1)\n");
	assert.equal(process.exitCode, 130);
});

test("a second SIGINT takes the prompt hard-exit path", async (t) => {
	const controlled = controlPrompt(t, "running");
	const exits: Array<string | number | null | undefined> = [];
	t.mock.method(process, "exit", (code: string | number | null | undefined) => {
		exits.push(code);
		return undefined as never;
	});
	const running = run();
	await controlled.promptStarted.promise;
	const interrupt = findNewSignalListener(controlled.signalListeners);

	interrupt("SIGINT");
	interrupt("SIGINT");
	controlled.promptResponse.resolve(jsonResponse(admission("running"), 202));
	await running;

	assert.deepEqual(exits, [130]);
	assert.equal(process.exitCode, 130);
});

interface ControlledPrompt {
	promptStarted: PromiseWithResolvers<void>;
	promptResponse: PromiseWithResolvers<Response>;
	cancelBodies: Array<{ sessionId: string; turnId: string }>;
	signalListeners: Set<(signal: NodeJS.Signals) => void>;
	stderr: string[];
	closeStream(): void;
}

function controlPrompt(
	t: TestContext,
	status: Protocol.AdmissionStatus,
	snapshots: Protocol.SessionSnapshot[] = [snapshot()],
): ControlledPrompt {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const promptStarted = Promise.withResolvers<void>();
	const promptResponse = Promise.withResolvers<Response>();
	const streamController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const cancelBodies: Array<{ sessionId: string; turnId: string }> = [];
	const signalListeners = new Set(process.listeners("SIGINT"));
	const stderr: string[] = [];
	let snapshotCalls = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController.resolve(controller);
		},
	});

	process.argv = [process.execPath, "ker", "--session", "session-1", "hello"];
	process.exitCode = undefined;
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	t.mock.method(process.stdout, "write", () => true);
	globalThis.fetch = async (input, init): Promise<Response> => {
		const path = new URL(String(input)).pathname;
		if (path === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION }, 200);
		if (path === "/sessions/session-1") {
			const current = snapshots[Math.min(snapshotCalls++, snapshots.length - 1)];
			return jsonResponse(current, 200);
		}
		if (path === "/sessions/session-1/events") {
			init?.signal?.addEventListener(
				"abort",
				() => void streamController.promise.then((controller) => controller.close()),
				{ once: true },
			);
			return new Response(body, { status: 200 });
		}
		if (path === "/sessions/session-1/prompts") {
			promptStarted.resolve();
			return promptResponse.promise;
		}
		if (path === "/sessions/session-1/turns/turn-1/cancel") {
			cancelBodies.push({ sessionId: "session-1", turnId: "turn-1" });
			const cancellationStatus = status === "waiting" ? "cancelled" : "cancelling";
			return jsonResponse(
				{ status: cancellationStatus, sessionId: "session-1", turnId: "turn-1" },
				cancellationStatus === "cancelling" ? 202 : 200,
			);
		}
		throw new Error(`Unexpected request to ${path}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});
	return {
		promptStarted,
		promptResponse,
		cancelBodies,
		signalListeners,
		stderr,
		closeStream() {
			void streamController.promise.then((controller) => controller.close());
		},
	};
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
		entries: [],
		messages: [],
		turns: [],
		queue: { revision: 0, waiting: [] },
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function terminalSnapshot(status: Protocol.TurnTerminalReason): Protocol.SessionSnapshot {
	return {
		...snapshot(),
		turns: [{ id: "turn-1", status }],
		queue: { revision: 2, waiting: [] },
		cursor: { epoch: "epoch-2", sequence: 0 },
	};
}

function admission(status: Protocol.AdmissionStatus): Protocol.PromptAdmission {
	return {
		status,
		sessionId: "session-1",
		turnId: "turn-1",
		messageId: "message-1",
		queueItemId: "queue-1",
		queue: { revision: 1, waiting: [] },
	};
}

function findNewSignalListener(before: Set<(signal: NodeJS.Signals) => void>): (signal: NodeJS.Signals) => void {
	const listener = process.listeners("SIGINT").find((candidate) => !before.has(candidate));
	assert(listener);
	return listener;
}

async function waitFor(condition: () => boolean): Promise<void> {
	while (!condition()) await new Promise<void>((resolve) => setImmediate(resolve));
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
