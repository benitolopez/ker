import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("monitor", async (t) => {
	await t.test("renders snapshot conversation, active output, and queued prompts in turn order", async (t) => {
		const snapshot = conversationSnapshot();
		const controlled = controlMonitor(t, { initial: snapshot, recovered: snapshot });
		const running = run();
		await controlled.firstSubscribed.promise;
		controlled.closeFirst();
		await controlled.followingSubscribed.promise;

		assert.equal(controlled.stdout.join(""), "saved\npartial\nactive");
		assert.equal(
			controlled.stderr.join(""),
			[
				"> first\n",
				"> question\n",
				"> second\n",
				"ker: daemon restarted\n",
				"ker: check tool effects\n",
				"> third\n",
				"> queued\n",
				"> prompt\n",
			].join(""),
		);
		assert.deepEqual(controlled.writes.slice(0, 8), [
			{ stream: "stderr", text: "> first\n" },
			{ stream: "stderr", text: "> question\n" },
			{ stream: "stdout", text: "saved" },
			{ stream: "stdout", text: "\n" },
			{ stream: "stderr", text: "> second\n" },
			{ stream: "stdout", text: "partial" },
			{ stream: "stdout", text: "\n" },
			{ stream: "stderr", text: "ker: daemon restarted\n" },
		]);

		findNewSignalListener(controlled.signalListeners)("SIGINT");
		await running;
	});

	await t.test("renders live prompts, failures, and lifecycle events while ignoring rich events", async (t) => {
		const initial = emptySnapshot();
		const controlled = controlMonitor(t, { initial, recovered: initial });
		const running = run();
		await controlled.firstSubscribed.promise;
		controlled.emit([
			submitted("live", "prompt-live", "live\nprompt", "running"),
			{
				actor: "human",
				modelRole: "user",
				sessionId: "session-1",
				turnId: "live",
				type: "message_delivered",
				messageId: "prompt-live",
				text: "live\nprompt",
			},
			{
				actor: "agent",
				modelRole: "assistant",
				sessionId: "session-1",
				turnId: "live",
				type: "message_delta",
				messageId: "assistant-live",
				offset: 0,
				text: "answer",
			},
			{
				actor: "agent",
				modelRole: "assistant",
				sessionId: "session-1",
				turnId: "live",
				type: "reasoning_delta",
				messageId: "reasoning-live",
				offset: 0,
				text: "hidden",
			},
			{
				actor: "agent",
				modelRole: "assistant",
				sessionId: "session-1",
				turnId: "live",
				type: "tool_call",
				messageId: "assistant-live",
				id: "call-1",
				name: "read",
				arguments: "{}",
			},
			{
				actor: "process",
				modelRole: "tool",
				sessionId: "session-1",
				turnId: "live",
				type: "tool_result",
				id: "call-1",
				name: "read",
				status: "ok",
				output: "hidden",
			},
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "live",
				type: "usage",
				input: 1,
				output: 2,
				total: 3,
			},
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "live",
				type: "retry",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 10,
				message: "hidden",
			},
			{ actor: "process", sessionId: "session-1", turnId: "live", type: "auth", mode: "oauth" },
			{
				actor: "agent",
				modelRole: "assistant",
				sessionId: "session-1",
				turnId: "live",
				type: "assistant_message_completed",
				messageId: "assistant-live",
				reason: "completed",
			},
			submitted("waiting", "prompt-waiting", "queued", "waiting"),
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "waiting",
				type: "message_undelivered",
				messageId: "prompt-waiting",
				text: "queued",
				reason: "cancelled",
			},
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "failed",
				type: "error",
				message: "credential changed",
				code: "identity_changed",
				expected: { kind: "oauth", accountId: "old" },
				actual: { kind: "oauth", accountId: "new" },
			},
			terminal("failed", "error"),
			{ actor: "human", sessionId: "session-1", turnId: "cancelled", type: "turn_cancel_requested" },
			terminal("cancelled", "cancelled"),
		]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controlled.closeFirst();
		await controlled.followingSubscribed.promise;

		assert.equal(controlled.stdout.join(""), "answer\n");
		assert.equal(
			controlled.stderr.join(""),
			[
				"ker: waiting for turns\n",
				"> live\n",
				"> prompt\n",
				"> queued\n",
				"ker: prompt was not delivered: cancelled (turn waiting)\n",
				"ker: credential changed\n",
				"ker: log back into that account with `ker login`, or create a session with `ker new`\n",
				"ker: error (turn failed)\n",
				"ker: cancelling (turn cancelled)\n",
				"ker: cancelled (turn cancelled)\n",
			].join(""),
		);

		findNewSignalListener(controlled.signalListeners)("SIGINT");
		await running;
	});

	await t.test("renders live and resnapshot lifecycle transitions once and keeps following", async (t) => {
		const controlled = controlMonitor(t);
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
				"> hello\n",
				"ker: cancelling (turn current)\n",
				"ker: aborted (turn current)\n",
				"ker: cancelling (turn live)\n",
				"ker: cancelled (turn live)\n",
				"ker: error (turn missed)\n",
				"ker: waiting for turns\n",
			].join(""),
		);
		assert.equal(await Promise.race([running.then(() => "detached"), Promise.resolve("monitoring")]), "monitoring");

		const detach = findNewSignalListener(controlled.signalListeners);
		detach("SIGINT");
		await running;
		assert.equal(
			controlled.paths.some((path) => path.endsWith("/cancel")),
			false,
		);
	});

	await t.test("reports an initially idle session once", async (t) => {
		const controlled = controlMonitor(t, { initial: recoveredSnapshot(), recovered: recoveredSnapshot() });
		const running = run();
		await controlled.firstSubscribed.promise;
		controlled.closeFirst();
		await controlled.followingSubscribed.promise;

		assert.equal(controlled.stderr.join(""), "ker: waiting for turns\n");
		findNewSignalListener(controlled.signalListeners)("SIGINT");
		await running;
	});

	await t.test("resnapshots append only newly discovered conversation output and status", async (t) => {
		const controlled = controlMonitor(t, {
			initial: resyncInitialSnapshot(),
			recovered: resyncRecoveredSnapshot(),
		});
		const running = run();
		await controlled.firstSubscribed.promise;
		controlled.emit([
			submitted("queued", "prompt-queued", "queued live", "waiting"),
			{
				actor: "agent",
				modelRole: "assistant",
				sessionId: "session-1",
				turnId: "current",
				type: "message_delta",
				messageId: "assistant-current",
				offset: 4,
				text: "ial",
			},
		]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controlled.closeFirst();
		await controlled.followingSubscribed.promise;

		assert.equal(controlled.stdout.join(""), "old\npartial\nmissed answer\n");
		assert.equal(
			controlled.stderr.join(""),
			[
				"> ask\n",
				"> queued live\n",
				"ker: restart notice\n",
				"> missed prompt\n",
				"> still queued\n",
				"ker: error (turn current)\n",
			].join(""),
		);

		findNewSignalListener(controlled.signalListeners)("SIGINT");
		await running;
	});

	await t.test("JSON output contains only snapshots and event envelopes", async (t) => {
		const controlled = controlMonitor(t, { json: true });
		const running = run();
		await controlled.firstSubscribed.promise;
		const event = terminal("current", "aborted");
		controlled.emit([event]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controlled.closeFirst();
		await controlled.followingSubscribed.promise;
		findNewSignalListener(controlled.signalListeners)("SIGINT");
		await running;

		assert.equal(
			controlled.stdout.join(""),
			[
				JSON.stringify(initialSnapshot()),
				JSON.stringify({ epoch: "epoch-1", sequence: 1, event }),
				JSON.stringify(recoveredSnapshot()),
				"",
			].join("\n"),
		);
		assert.equal(controlled.stderr.join(""), "");
	});
});

interface ControlledMonitor {
	firstSubscribed: PromiseWithResolvers<void>;
	followingSubscribed: PromiseWithResolvers<void>;
	paths: string[];
	signalListeners: Set<(signal: NodeJS.Signals) => void>;
	stderr: string[];
	stdout: string[];
	writes: Array<{ stream: "stderr" | "stdout"; text: string }>;
	emit(events: Protocol.Event[]): void;
	closeFirst(): void;
}

function controlMonitor(
	t: TestContext,
	options: { json?: boolean; initial?: Protocol.SessionSnapshot; recovered?: Protocol.SessionSnapshot } = {},
): ControlledMonitor {
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
	const writes: Array<{ stream: "stderr" | "stdout"; text: string }> = [];
	const encoder = new TextEncoder();
	const firstBody = new ReadableStream<Uint8Array>({
		start(controller) {
			firstController.resolve(controller);
		},
	});
	let snapshotCalls = 0;
	let eventCalls = 0;

	process.argv = [process.execPath, "ker", ...(options.json ? ["--json"] : []), "monitor", "session-1"];
	process.exitCode = undefined;
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		const text = String(chunk);
		stderr.push(text);
		writes.push({ stream: "stderr", text });
		return true;
	});
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		const text = String(chunk);
		stdout.push(text);
		writes.push({ stream: "stdout", text });
		return true;
	});
	globalThis.fetch = async (input, init): Promise<Response> => {
		const path = new URL(String(input)).pathname;
		paths.push(path);
		if (path === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION }, 200);
		if (path === "/sessions/session-1") {
			snapshotCalls++;
			return jsonResponse(
				snapshotCalls === 1 ? (options.initial ?? initialSnapshot()) : (options.recovered ?? recoveredSnapshot()),
				200,
			);
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
		writes,
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

function conversationSnapshot(): Protocol.SessionSnapshot {
	return {
		session: session(),
		entries: [
			entry("entry-user-1", "turn-1", "user", "first\nquestion", "prompt-1"),
			entry("entry-assistant-1", "turn-1", "assistant", "saved", "assistant-1"),
			entry("entry-user-2", "turn-2", "user", "second", "prompt-2"),
			entry("entry-assistant-2", "turn-2", "assistant", "partial"),
			entry("entry-developer-2", "turn-2", "developer", "daemon restarted\ncheck tool effects"),
			entry("entry-user-3", "turn-3", "user", "third", "prompt-3"),
		],
		messages: [
			{ id: "assistant-1", turnId: "turn-1", text: "saved", reason: "completed" },
			{ id: "assistant-2", turnId: "turn-2", text: "partial", reason: "error" },
		],
		active: { id: "assistant-3", turnId: "turn-3", text: "active" },
		turns: [
			{ id: "turn-1", status: "completed" },
			{ id: "turn-2", status: "error" },
			{ id: "turn-3", status: "running" },
			{ id: "turn-4", status: "waiting" },
		],
		queue: {
			revision: 4,
			running: { ...queueItem("turn-3", "running"), messageId: "prompt-3", text: "third" },
			waiting: [
				{
					...queueItem("turn-4", "waiting"),
					messageId: "prompt-4",
					text: "queued\nprompt",
				},
			],
		},
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function emptySnapshot(): Protocol.SessionSnapshot {
	return {
		session: session(),
		entries: [],
		messages: [],
		turns: [],
		queue: { revision: 0, waiting: [] },
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function resyncInitialSnapshot(): Protocol.SessionSnapshot {
	return {
		session: session(),
		entries: [
			entry("entry-assistant-old", "old", "assistant", "old", "assistant-old"),
			entry("entry-user-current", "current", "user", "ask", "prompt-current"),
		],
		messages: [{ id: "assistant-old", turnId: "old", text: "old", reason: "completed" }],
		active: { id: "assistant-current", turnId: "current", text: "part" },
		turns: [
			{ id: "old", status: "completed" },
			{ id: "current", status: "running" },
		],
		queue: {
			revision: 1,
			running: {
				...queueItem("current", "running"),
				messageId: "prompt-current",
				text: "ask",
			},
			waiting: [],
		},
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function resyncRecoveredSnapshot(): Protocol.SessionSnapshot {
	return {
		session: session(),
		entries: [
			entry("entry-assistant-old", "old", "assistant", "old", "assistant-old"),
			entry("entry-user-current", "current", "user", "ask", "prompt-current"),
			entry("entry-assistant-current", "current", "assistant", "partial"),
			entry("entry-developer-current", "current", "developer", "restart notice"),
			entry("entry-user-queued", "queued", "user", "queued live", "prompt-queued"),
			entry("entry-user-missed", "missed", "user", "missed prompt", "prompt-missed"),
			entry("entry-assistant-missed", "missed", "assistant", "missed answer", "assistant-missed"),
		],
		messages: [
			{ id: "assistant-old", turnId: "old", text: "old", reason: "completed" },
			{ id: "assistant-current", turnId: "current", text: "partial", reason: "error" },
			{ id: "assistant-missed", turnId: "missed", text: "missed answer", reason: "completed" },
		],
		turns: [
			{ id: "old", status: "completed" },
			{ id: "current", status: "error" },
			{ id: "missed", status: "completed" },
			{ id: "queue-new", status: "waiting" },
		],
		queue: {
			revision: 3,
			waiting: [
				{
					...queueItem("queue-new", "waiting"),
					messageId: "prompt-queue-new",
					text: "still queued",
				},
			],
		},
		cursor: { epoch: "epoch-2", sequence: 0 },
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
		turnId,
		messageId: `message-${turnId}`,
		text: "hello",
		state,
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
}

function entry(
	id: string,
	turnId: string,
	role: "user" | "assistant" | "developer",
	content: string,
	messageId?: string,
): Protocol.ConversationEntry {
	const base = { id, parentId: null, turnId, messageId, content };
	if (role === "assistant") return { ...base, role, toolCalls: [] };
	return { ...base, role };
}

function submitted(
	turnId: string,
	messageId: string,
	text: string,
	admission: Protocol.AdmissionStatus,
): Protocol.MessageSubmittedEvent {
	return {
		actor: "human",
		sessionId: "session-1",
		turnId,
		type: "message_submitted",
		messageId,
		queueItemId: `queue-${turnId}`,
		text,
		admission,
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
