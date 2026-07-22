import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("attach renders live and resnapshot lifecycle transitions once and keeps following", async (t) => {
	const controlled = controlAttach(t);
	const running = run();
	await controlled.firstSubscribed.promise;

	controlled.emit([
		terminal("current", "aborted"),
		{ actor: "human", sessionId: "session-1", turnId: "live", type: "turn_cancel_requested" },
		terminal("live", "cancelled"),
		{ actor: "process", sessionId: "session-1", turnId: "live", type: "end" },
	]);
	controlled.closeFirst();
	await controlled.followingSubscribed.promise;

	assert.equal(controlled.stdout.join(""), "saved\n");
	assert.equal(
		controlled.stderr.join(""),
		[
			"ker: cancelling (turn current)\n",
			"ker: aborted (turn current)\n",
			"ker: cancelling (turn live)\n",
			"ker: cancelled (turn live)\n",
			"ker: error (turn missed)\n",
		].join(""),
	);
	assert.equal(await Promise.race([running.then(() => "detached"), Promise.resolve("attached")]), "attached");

	const detach = findNewSignalListener(controlled.signalListeners);
	detach("SIGINT");
	await running;
	assert.equal(
		controlled.paths.some((path) => path.endsWith("/cancel")),
		false,
	);
});

interface ControlledAttach {
	firstSubscribed: PromiseWithResolvers<void>;
	followingSubscribed: PromiseWithResolvers<void>;
	paths: string[];
	signalListeners: Set<(signal: NodeJS.Signals) => void>;
	stderr: string[];
	stdout: string[];
	emit(events: Protocol.Event[]): void;
	closeFirst(): void;
}

function controlAttach(t: TestContext): ControlledAttach {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const firstSubscribed = Promise.withResolvers<void>();
	const followingSubscribed = Promise.withResolvers<void>();
	const firstController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const signalListeners = new Set(process.listeners("SIGINT"));
	const paths: string[] = [];
	const stderr: string[] = [];
	const stdout: string[] = [];
	const encoder = new TextEncoder();
	const firstBody = new ReadableStream<Uint8Array>({
		start(controller) {
			firstController.resolve(controller);
		},
	});
	let snapshotCalls = 0;
	let eventCalls = 0;

	process.argv = [process.execPath, "ker", "attach", "session-1"];
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
		paths.push(path);
		if (path === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION }, 200);
		if (path === "/sessions/session-1") {
			snapshotCalls++;
			return jsonResponse(snapshotCalls === 1 ? initialSnapshot() : recoveredSnapshot(), 200);
		}
		if (path === "/sessions/session-1/events") {
			eventCalls++;
			if (eventCalls === 1) {
				firstSubscribed.resolve();
				return new Response(firstBody, { status: 200 });
			}
			if (eventCalls === 2) return jsonResponse({ code: "resync_required" }, 410);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					if (init?.signal?.aborted) {
						controller.close();
						return;
					}
					init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
				},
			});
			followingSubscribed.resolve();
			return new Response(body, { status: 200 });
		}
		throw new Error(`Unexpected request to ${path}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});

	return {
		firstSubscribed,
		followingSubscribed,
		paths,
		signalListeners,
		stderr,
		stdout,
		emit(events) {
			void firstController.promise.then((controller) => {
				for (const [index, event] of events.entries()) {
					const envelope: Protocol.EventEnvelope = { epoch: "epoch-1", sequence: index + 1, event };
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
				}
			});
		},
		closeFirst() {
			void firstController.promise.then((controller) => controller.close());
		},
	};
}

function initialSnapshot(): Protocol.SessionSnapshot {
	return {
		session: session(),
		entries: [],
		messages: [{ id: "assistant-1", turnId: "historical", text: "saved", reason: "completed" }],
		turns: [
			{ id: "historical", status: "cancelled" },
			{ id: "current", status: "cancelling" },
		],
		queue: { revision: 2, running: queueItem("current", "cancelling"), waiting: [] },
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function recoveredSnapshot(): Protocol.SessionSnapshot {
	return {
		session: session(),
		entries: [],
		messages: [{ id: "assistant-1", turnId: "historical", text: "saved", reason: "completed" }],
		turns: [
			{ id: "historical", status: "cancelled" },
			{ id: "current", status: "aborted" },
			{ id: "live", status: "cancelled" },
			{ id: "missed", status: "error" },
		],
		queue: { revision: 3, waiting: [] },
		cursor: { epoch: "epoch-2", sequence: 0 },
	};
}

function session(): Protocol.SessionDescriptor {
	return {
		id: "session-1",
		cwd: "/project",
		projectRoot: "/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function queueItem(turnId: string, state: Protocol.QueueItem["state"]): Protocol.QueueItem {
	return {
		id: `queue-${turnId}`,
		sessionId: "session-1",
		turnId,
		messageId: `message-${turnId}`,
		text: "hello",
		state,
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
}

function terminal(turnId: string, reason: Protocol.TurnTerminalReason): Protocol.TurnTerminalEvent {
	return { actor: "process", sessionId: "session-1", turnId, type: "turn_terminal", reason };
}

function findNewSignalListener(before: Set<(signal: NodeJS.Signals) => void>): (signal: NodeJS.Signals) => void {
	const listener = process.listeners("SIGINT").find((candidate) => !before.has(candidate));
	assert(listener);
	return listener;
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
