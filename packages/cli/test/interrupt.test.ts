import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("an admitted prompt waits for its turn and prints only assistant text", async (t) => {
	const controlled = controlPrompt(t, "running");
	const running = run();
	await controlled.promptStarted.promise;
	controlled.promptResponse.resolve(jsonResponse(admission("running"), 202));
	controlled.complete([
		{
			actor: "human",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "message_submitted",
			messageId: "message-1",
			queueItemId: "queue-1",
			text: "hello",
			admission: "running",
		},
		{
			actor: "human",
			modelRole: "user",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "message_delivered",
			messageId: "message-1",
			text: "hello",
		},
		{
			actor: "agent",
			modelRole: "assistant",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "message_delta",
			messageId: "assistant-1",
			offset: 0,
			text: "answer",
		},
		{
			actor: "agent",
			modelRole: "assistant",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "assistant_message_completed",
			messageId: "assistant-1",
			reason: "completed",
		},
		terminal("completed"),
		end(),
	]);
	await running;

	assert.equal(controlled.stdout.join(""), "answer\n");
	assert.equal(controlled.stderr.join(""), "");
	assert.deepEqual(controlled.cancelBodies, []);
	assert.deepEqual(controlled.promptBodies, [{ text: "hello" }]);
});

test("a waiting prompt remains connected until its own turn finishes", async (t) => {
	const controlled = controlPrompt(t, "waiting");
	const running = run();
	await controlled.promptStarted.promise;
	controlled.promptResponse.resolve(jsonResponse(admission("waiting"), 202));

	assert.equal(await Promise.race([running.then(() => "done"), Promise.resolve("waiting")]), "waiting");
	controlled.complete([terminal("completed"), end()]);
	await running;
	assert.match(controlled.stderr.join(""), /ker: waiting/);
});

test("SIGINT racing admission cancels the exact returned turn", async (t) => {
	const controlled = controlPrompt(t, "running");
	const running = run();
	await controlled.promptStarted.promise;
	const interrupt = findNewSignalListener(controlled.signalListeners);
	interrupt("SIGINT");
	controlled.promptResponse.resolve(jsonResponse(admission("running"), 202));
	await running;

	assert.deepEqual(controlled.cancelBodies, [{ sessionId: "session-1", turnId: "turn-1" }]);
	assert.equal(controlled.stderr.join(""), "ker: cancelling (turn turn-1)\n");
	assert.equal(process.exitCode, 130);
});

test("external cancellation reports both transitions and exits 130", async (t) => {
	const controlled = controlPrompt(t, "running");
	const running = run();
	await controlled.promptStarted.promise;
	controlled.promptResponse.resolve(jsonResponse(admission("running"), 202));
	controlled.complete([
		{ actor: "human", sessionId: "session-1", turnId: "turn-1", type: "turn_cancel_requested" },
		{ actor: "process", sessionId: "session-1", turnId: "turn-1", type: "aborted" },
		terminal("aborted"),
		end(),
	]);
	await running;

	assert.equal(controlled.stderr.join(""), "ker: cancelling (turn turn-1)\nker: aborted (turn turn-1)\n");
	assert.equal(process.exitCode, 130);
});

test("rejects attach and obsolete placement flags through usage handling", async (t) => {
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const stderr: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	t.after(() => {
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});
	for (const args of [
		["attach", "session-1"],
		["--session", "session-1", "--to-turn", "turn-1", "steer"],
		["--session", "session-1", "--after-turn", "turn-1", "next"],
	]) {
		process.argv = [process.execPath, "ker", ...args];
		process.exitCode = undefined;
		await run();
		assert.equal(process.exitCode, 1);
	}
	assert.equal(stderr.filter((line) => line.startsWith("usage: ker")).length, 3);
});

test("--json prints the snapshot and raw event envelopes", async (t) => {
	const controlled = controlPrompt(t, "running", ["--json", "--session", "session-1", "hello"]);
	const running = run();
	await controlled.promptStarted.promise;
	controlled.promptResponse.resolve(jsonResponse(admission("running"), 202));
	controlled.complete([terminal("completed"), end()]);
	await running;

	const lines = controlled.stdout
		.join("")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown);
	assert.deepEqual(lines[0], snapshot());
	assert.equal((lines[1] as Protocol.EventEnvelope).event.type, "turn_terminal");
	assert.equal((lines[2] as Protocol.EventEnvelope).event.type, "end");
});

interface ControlledPrompt {
	promptStarted: PromiseWithResolvers<void>;
	promptResponse: PromiseWithResolvers<Response>;
	cancelBodies: Array<{ sessionId: string; turnId: string }>;
	promptBodies: object[];
	signalListeners: Set<(signal: NodeJS.Signals) => void>;
	stderr: string[];
	stdout: string[];
	complete(events: Protocol.Event[]): void;
}

function controlPrompt(
	t: TestContext,
	status: Protocol.AdmissionStatus,
	args = ["--session", "session-1", "hello"],
	snapshots: Protocol.SessionSnapshot[] = [snapshot()],
): ControlledPrompt {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const promptStarted = Promise.withResolvers<void>();
	const promptResponse = Promise.withResolvers<Response>();
	const streamController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const cancelBodies: Array<{ sessionId: string; turnId: string }> = [];
	const promptBodies: object[] = [];
	const signalListeners = new Set(process.listeners("SIGINT"));
	const stderr: string[] = [];
	const stdout: string[] = [];
	const encoder = new TextEncoder();
	let snapshotCalls = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController.resolve(controller);
		},
	});

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
	globalThis.fetch = async (input, init): Promise<Response> => {
		const path = new URL(String(input)).pathname;
		if (path === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION }, 200);
		if (path === "/sessions/session-1" && init?.method !== "POST") {
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
			promptBodies.push(JSON.parse(String(init?.body)) as object);
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
		promptBodies,
		signalListeners,
		stderr,
		stdout,
		complete(events) {
			void streamController.promise.then((controller) => {
				for (const [index, event] of events.entries()) {
					const envelope: Protocol.EventEnvelope = { epoch: "epoch-1", sequence: index + 1, event };
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
				}
				controller.close();
			});
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

function terminal(reason: Protocol.TurnTerminalReason): Protocol.TurnTerminalEvent {
	return {
		actor: "process",
		sessionId: "session-1",
		turnId: "turn-1",
		type: "turn_terminal",
		reason,
	};
}

function end(): Protocol.EndEvent {
	return { actor: "process", sessionId: "session-1", turnId: "turn-1", type: "end" };
}

function findNewSignalListener(before: Set<(signal: NodeJS.Signals) => void>): (signal: NodeJS.Signals) => void {
	const listener = process.listeners("SIGINT").find((candidate) => !before.has(candidate));
	assert(listener);
	return listener;
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
