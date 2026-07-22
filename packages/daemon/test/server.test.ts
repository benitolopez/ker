import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { createDaemon, type DaemonOptions, type Harness } from "../src/index.ts";
import { type Payload, SessionStore } from "../src/store.ts";

const LOCAL_HOST = "127.0.0.1:5537";

test("creates and lists explicit durable sessions", async (t) => {
	const running = await startServer(t, immediateFactory());
	const first = await createSession(running.url);
	const second = await createSession(running.url);
	const response = await localFetch(`${running.url}/sessions`);
	const listed = await readJson<{ sessions: Protocol.SessionDescriptor[] }>(response.body);

	assert.equal(response.status, 200);
	assert.deepEqual(
		listed.sessions.map((session) => session.id),
		[first.id, second.id],
	);
	assert(listed.sessions.every((session) => session.cwd === "/project"));
	assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 404);
});

test("keeps healthy sessions available when another session log is unreadable", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-malformed-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir, projectRoot: "/project" });
	const malformed = await store.create("/project");
	const healthy = await store.create("/project");
	const original = await readFile(malformed.log.path, "utf8");
	await writeFile(malformed.log.path, `${original}not-json\n{"also":"bad"}`);
	const running = await startServer(t, immediateFactory(), { sessionDir });

	const health = await localFetch(`${running.url}/health`);
	assert.equal(health.status, 200);
	const listedResponse = await localFetch(`${running.url}/sessions`);
	const listed = await readJson<{
		sessions: Protocol.SessionDescriptor[];
		unreadable: Protocol.UnreadableSession[];
	}>(listedResponse.body);
	assert.deepEqual(
		listed.sessions.map((session) => session.id),
		[healthy.session.id],
	);
	assert.equal(listed.unreadable[0]?.id, malformed.session.id);
	const corruptSnapshot = await localFetch(`${running.url}/sessions/${malformed.session.id}`);
	assert.equal(corruptSnapshot.status, 500);
	assert.equal((await readJson<{ code: string }>(corruptSnapshot.body)).code, "session_unreadable");
});

test("normal prompts preserve project-wide arrival order", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const firstSession = await createSession(running.url);
	const secondSession = await createSession(running.url);

	const first = await prompt(running.url, firstSession.id, "A");
	assert.equal(first.status, "running");
	await controlled.started(0);
	const second = await prompt(running.url, secondSession.id, "B");
	const third = await prompt(running.url, firstSession.id, "A2");
	assert.equal(second.status, "waiting");
	assert.equal(third.status, "waiting");
	assert.equal(second.queue.revision, first.queue.revision + 1);
	assert.equal(third.queue.revision, second.queue.revision + 1);
	assert.deepEqual(
		third.queue.waiting.map((item) => item.text),
		["B", "A2"],
	);

	controlled.release(0);
	await controlled.started(1);
	controlled.release(1);
	await controlled.started(2);
	controlled.release(2);
	await controlled.finished(2);
	assert.deepEqual(controlled.initials, ["A", "B", "A2"]);
});

test("after_turn inserts directly after the exact running turn", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);

	const first = await prompt(running.url, session.id, "A");
	await controlled.started(0);
	await prompt(running.url, session.id, "B");
	const inserted = await prompt(running.url, session.id, "A2", { type: "after_turn", turnId: first.turnId });
	assert.equal(inserted.status, "waiting");

	controlled.release(0);
	await controlled.started(1);
	controlled.release(1);
	await controlled.started(2);
	controlled.release(2);
	await controlled.finished(2);
	assert.deepEqual(controlled.initials, ["A", "A2", "B"]);
});

test("running_turn targets one live turn and never falls through to another", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	const first = await prompt(running.url, session.id, "A");
	await controlled.started(0);

	const wrong = await rawPrompt(running.url, session.id, "wrong", { type: "running_turn", turnId: "stale" });
	assert.equal(wrong.status, 409);
	const steering = await prompt(running.url, session.id, "A2", { type: "running_turn", turnId: first.turnId });
	assert.equal(steering.status, "added_to_running");
	assert.equal(steering.turnId, first.turnId);

	controlled.release(0);
	await controlled.finished(0);
	assert.deepEqual(controlled.inputs, ["A", "A2"]);
	const stale = await rawPrompt(running.url, session.id, "late", {
		type: "running_turn",
		turnId: first.turnId,
	});
	assert.equal(stale.status, 409);
});

test("cancels a whole waiting turn without aborting the running turn", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	await prompt(running.url, session.id, "A");
	await controlled.started(0);
	const waiting = await prompt(running.url, session.id, "B");

	const cancelled = await localFetch(`${running.url}/sessions/${session.id}/turns/${waiting.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(cancelled.status, 200);
	assert.deepEqual(await readJson(cancelled.body), {
		status: "cancelled",
		sessionId: session.id,
		turnId: waiting.turnId,
	});
	const afterCancellation = await getSnapshot(running.url, session.id);
	const duplicate = await localFetch(`${running.url}/sessions/${session.id}/turns/${waiting.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(duplicate.status, 200);
	assert.equal((await getSnapshot(running.url, session.id)).queue.revision, afterCancellation.queue.revision);
	controlled.release(0);
	await controlled.finished(0);
	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === waiting.turnId)?.status, "cancelled");
	assert.deepEqual(controlled.initials, ["A"]);
});

test("active cancellation becomes durable and returns before cleanup", async (t) => {
	const controlled = controlledFactory({ pauseAfterAbort: true });
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	const admitted = await prompt(running.url, session.id, "A");
	await controlled.deltaSeen(0);
	const before = await getSnapshot(running.url, session.id);
	const subscription = await localFetch(
		`${running.url}/sessions/${session.id}/events?epoch=${before.cursor.epoch}&sequence=${before.cursor.sequence}`,
	);
	const frames = readEnvelopes(subscription.body)[Symbol.asyncIterator]();

	const response = await localFetch(`${running.url}/sessions/${session.id}/turns/${admitted.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(response.status, 202);
	assert.deepEqual(await readJson(response.body), {
		status: "cancelling",
		sessionId: session.id,
		turnId: admitted.turnId,
	});
	const cancelling = await getSnapshot(running.url, session.id);
	assert.equal(cancelling.turns.find((turn) => turn.id === admitted.turnId)?.status, "cancelling");
	assert.equal(cancelling.queue.running?.state, "cancelling");
	assert.equal(
		await Promise.race([controlled.finished(0).then(() => "finished"), Promise.resolve("cleaning")]),
		"cleaning",
	);

	const duplicate = await localFetch(`${running.url}/sessions/${session.id}/turns/${admitted.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(duplicate.status, 202);
	assert.equal((await getSnapshot(running.url, session.id)).queue.revision, cancelling.queue.revision);

	controlled.releaseCleanup(0);
	const observed: Protocol.Event["type"][] = [];
	while (observed.at(-1) !== "end") {
		const next = await frames.next();
		assert.equal(next.done, false);
		const event = next.value.event;
		if ("turnId" in event && event.turnId === admitted.turnId) observed.push(event.type);
	}
	assert.deepEqual(
		observed.filter((type) => ["turn_cancel_requested", "aborted", "turn_terminal", "end"].includes(type)),
		["turn_cancel_requested", "aborted", "turn_terminal", "end"],
	);
	await frames.return?.(undefined);

	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.messages.length, 1);
	assert.deepEqual(
		{ ...snapshot.messages[0], id: undefined },
		{ id: undefined, turnId: admitted.turnId, text: "answer:A", reason: "aborted" },
	);
	const late = await localFetch(`${running.url}/sessions/${session.id}/turns/${admitted.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(late.status, 200);
	assert.deepEqual(await readJson(late.body), {
		status: "aborted",
		sessionId: session.id,
		turnId: admitted.turnId,
	});
	assert.equal((await getSnapshot(running.url, session.id)).queue.revision, snapshot.queue.revision);
});

test("concurrent cancellation requests record one transition", async (t) => {
	const controlled = controlledFactory({ pauseAfterAbort: true });
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	const admitted = await prompt(running.url, session.id, "A");
	await controlled.deltaSeen(0);
	const before = await getSnapshot(running.url, session.id);
	const subscription = await localFetch(
		`${running.url}/sessions/${session.id}/events?epoch=${before.cursor.epoch}&sequence=${before.cursor.sequence}`,
	);
	const cancelUrl = `${running.url}/sessions/${session.id}/turns/${admitted.turnId}/cancel`;

	const responses = await Promise.all([
		localFetch(cancelUrl, { method: "POST" }),
		localFetch(cancelUrl, { method: "POST" }),
	]);
	assert.deepEqual(
		responses.map((response) => response.status),
		[202, 202],
	);
	await Promise.all(responses.map((response) => readJson(response.body)));
	assert.equal((await getSnapshot(running.url, session.id)).queue.revision, before.queue.revision + 1);

	controlled.releaseCleanup(0);
	const events: Protocol.Event[] = [];
	for await (const envelope of readEnvelopes(subscription.body)) {
		events.push(envelope.event);
		if (envelope.event.type === "end" && envelope.event.turnId === admitted.turnId) break;
	}
	assert.equal(
		events.filter((event) => event.type === "turn_cancel_requested" && event.turnId === admitted.turnId).length,
		1,
	);
	assert.equal(events.filter((event) => event.type === "turn_terminal" && event.turnId === admitted.turnId).length, 1);
});

test("cancellation racing natural completion has one consistent outcome", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	const admitted = await prompt(running.url, session.id, "A");
	await controlled.deltaSeen(0);

	const cancellation = localFetch(`${running.url}/sessions/${session.id}/turns/${admitted.turnId}/cancel`, {
		method: "POST",
	});
	controlled.release(0);
	const response = await cancellation;
	assert([202, 409].includes(response.status));
	await readJson(response.body);
	await waitForTerminal(running.url, session.id, admitted.turnId);
	const snapshot = await getSnapshot(running.url, session.id);
	const status = snapshot.turns.find((turn) => turn.id === admitted.turnId)?.status;

	assert.equal(status, response.status === 202 ? "aborted" : "completed");
	assert.equal(snapshot.queue.running, undefined);
});

test("cancellation keeps successors waiting until abort cleanup finishes", async (t) => {
	const controlled = controlledFactory({ pauseAfterAbort: true });
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	const first = await prompt(running.url, session.id, "A");
	await controlled.deltaSeen(0);
	await prompt(running.url, session.id, "B");

	const response = await localFetch(`${running.url}/sessions/${session.id}/turns/${first.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(response.status, 202);
	await readJson(response.body);
	assert.equal(
		await Promise.race([controlled.started(1).then(() => "started"), Promise.resolve("waiting")]),
		"waiting",
	);

	controlled.releaseCleanup(0);
	await controlled.started(1);
	controlled.release(1);
	await controlled.finished(1);
	assert.deepEqual(controlled.initials, ["A", "B"]);
});

test("waiting cancellation racing promotion never retargets its successor", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	await prompt(running.url, session.id, "A");
	await controlled.deltaSeen(0);
	const second = await prompt(running.url, session.id, "B");
	const successor = await prompt(running.url, session.id, "C");

	const cancellation = localFetch(`${running.url}/sessions/${session.id}/turns/${second.turnId}/cancel`, {
		method: "POST",
	});
	controlled.release(0);
	const response = await cancellation;
	assert([200, 202].includes(response.status));
	await readJson(response.body);
	await waitForTerminal(running.url, session.id, second.turnId);
	while (!controlled.initials.includes("C")) await new Promise<void>((resolve) => setImmediate(resolve));
	const successorIndex = controlled.initials.indexOf("C");
	controlled.release(successorIndex);
	await controlled.finished(successorIndex);
	await waitForTerminal(running.url, session.id, successor.turnId);
	const snapshot = await getSnapshot(running.url, session.id);

	assert.equal(
		snapshot.turns.find((turn) => turn.id === second.turnId)?.status,
		response.status === 200 ? "cancelled" : "aborted",
	);
	assert.equal(snapshot.turns.find((turn) => turn.id === successor.turnId)?.status, "completed");
});

test("completed and unknown turns cannot be cancelled", async (t) => {
	const running = await startServer(t, immediateFactory());
	const session = await createSession(running.url);
	const admitted = await prompt(running.url, session.id, "done");
	await waitForTerminal(running.url, session.id, admitted.turnId);

	const completed = await localFetch(`${running.url}/sessions/${session.id}/turns/${admitted.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(completed.status, 409);
	const stale = await localFetch(`${running.url}/sessions/${session.id}/turns/stale/cancel`, { method: "POST" });
	assert.equal(stale.status, 409);
});

test("a snapshot exposes saved answers, an active partial, and a race-free cursor", async (t) => {
	const controlled = controlledFactory({ pauseAfterDelta: true });
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);
	const admitted = await prompt(running.url, session.id, "A");
	await controlled.deltaSeen(0);

	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.active?.turnId, admitted.turnId);
	assert.equal(snapshot.active?.text, "answer:A");
	const subscription = await localFetch(
		`${running.url}/sessions/${session.id}/events?epoch=${snapshot.cursor.epoch}&sequence=${snapshot.cursor.sequence}`,
	);
	assert.equal(subscription.status, 200);
	controlled.release(0);
	const frames = readEnvelopes(subscription.body)[Symbol.asyncIterator]();
	const completed = await readUntil(frames, (event) => event.type === "assistant_message_completed");
	assert.equal(completed.event.type, "assistant_message_completed");
	await frames.return?.(undefined);
});

test("an expired cursor returns resync_required", async (t) => {
	const running = await startServer(t, immediateFactory(), { eventTailSize: 2 });
	const session = await createSession(running.url);
	const before = await getSnapshot(running.url, session.id);
	const admitted = await prompt(running.url, session.id, "hello");
	await waitForTerminal(running.url, session.id, admitted.turnId);

	const response = await localFetch(
		`${running.url}/sessions/${session.id}/events?epoch=${before.cursor.epoch}&sequence=${before.cursor.sequence}`,
	);
	assert.equal(response.status, 410);
	assert.deepEqual(await readJson(response.body), { code: "resync_required" });
});

test("completed history loads after a daemon restart", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-restart-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const first = await startServer(t, immediateFactory(), { sessionDir }, false);
	const session = await createSession(first.url);
	const admitted = await prompt(first.url, session.id, "remember");
	await waitForTerminal(first.url, session.id, admitted.turnId);
	await first.close();

	const second = await startServer(t, immediateFactory(), { sessionDir }, false);
	const snapshot = await getSnapshot(second.url, session.id);
	assert.deepEqual(
		snapshot.messages.map((message) => message.text),
		["answer:remember"],
	);
	await second.close();
});

test("restart marks an active turn interrupted without repeating its work", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-interrupted-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir, projectRoot: "/project" });
	const seeded = await seedRunning(store, []);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), { sessionDir });
	const snapshot = await getSnapshot(running.url, seeded.session.id);

	assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "interrupted");
	assert.deepEqual(snapshot.messages, []);
	assert.equal(snapshot.queue.running, undefined);
	assert.equal(captured.at(-1)?.messages.at(-1)?.role, "developer");
});

test("restart repairs an advertised tool call without executing it again", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-tool-repair-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir, projectRoot: "/project" });
	const seeded = await seedRunning(store, [
		{
			type: "conversation",
			id: "entry-assistant",
			parentId: "entry-user",
			turnId: "turn-1",
			message: {
				role: "assistant",
				content: "",
				toolCalls: [{ callId: "call-1", name: "write", arguments: "{}" }],
				reasoning: [],
			},
		},
	]);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), { sessionDir });
	await getSnapshot(running.url, seeded.session.id);
	const restored = captured.at(-1)?.messages;

	assert.deepEqual(restored?.at(-2), {
		role: "tool",
		toolCallId: "call-1",
		content: "Tool result unavailable because the daemon stopped during the turn.",
	});
	assert.equal(restored?.at(-1)?.role, "developer");
});

test("restart finalizes a durable cancellation as aborted without repeating tools", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-cancelling-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir, projectRoot: "/project" });
	const seeded = await seedRunning(
		store,
		[
			{
				type: "conversation",
				id: "entry-assistant",
				parentId: "entry-user",
				turnId: "turn-1",
				message: {
					role: "assistant",
					content: "",
					toolCalls: [{ callId: "call-1", name: "write", arguments: "{}" }],
					reasoning: [],
				},
			},
		],
		"cancelling",
	);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), { sessionDir });
	const snapshot = await getSnapshot(running.url, seeded.session.id);

	assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "aborted");
	assert.equal(snapshot.queue.running, undefined);
	assert.deepEqual(captured.at(-1)?.messages.at(-2), {
		role: "tool",
		toolCallId: "call-1",
		content: "Tool result unavailable because the daemon stopped during the turn.",
	});
	const marker = captured.at(-1)?.messages.at(-1);
	assert.equal(marker?.role, "developer");
	if (marker?.role === "developer") assert.match(marker.content, /cancelled before a daemon restart finished cleanup/);
});

test("restart finishes cancellation cleanup before starting its queued successor", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-cancelling-queue-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir, projectRoot: "/project" });
	const seeded = await seedCancellingWithWaiting(store);
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory, { sessionDir });
	await controlled.started(0);
	const recovered = await getSnapshot(running.url, seeded.session.session.id);

	assert.equal(recovered.turns.find((turn) => turn.id === "turn-1")?.status, "aborted");
	assert.equal(recovered.turns.find((turn) => turn.id === seeded.waiting.turnId)?.status, "running");
	assert.deepEqual(controlled.initials, ["next"]);

	controlled.release(0);
	await controlled.finished(0);
	await waitForTerminal(running.url, seeded.session.session.id, seeded.waiting.turnId);
	const completed = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(completed.turns.find((turn) => turn.id === seeded.waiting.turnId)?.status, "completed");
});

function immediateFactory(): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			async *send(input) {
				state.messages.push({ role: "user", content: input.initial.text });
				yield delivered(input.initial);
				const messageId = randomUUID();
				const text = `answer:${input.initial.text}`;
				yield delta(input.initial, messageId, text);
				state.messages.push({ role: "assistant", content: text, toolCalls: [], reasoning: [] });
				yield completed(input.initial, messageId);
				yield end(input.initial);
			},
		};
	};
}

function passiveFactory(captured: Engine.HarnessState[]): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		captured.push(state);
		return {
			snapshot: () => structuredClone(state),
			send() {
				return {
					[Symbol.asyncIterator]: () => ({
						next: async (): Promise<IteratorResult<Protocol.TurnEvent>> => {
							throw new Error("Recovered running work must not be sent again");
						},
					}),
				};
			},
		};
	};
}

async function seedRunning(store: SessionStore, extra: Payload[], state: "running" | "cancelling" = "running") {
	const session = await store.create("/project");
	const item: Protocol.QueueItem = {
		id: "queue-1",
		sessionId: session.session.id,
		turnId: "turn-1",
		messageId: "message-1",
		text: "hello",
		state,
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
	const scopedExtra = extra.map((payload) => {
		if (payload.type !== "event") return payload;
		return { ...payload, event: { ...payload.event, sessionId: session.session.id } };
	});
	await session.log.append([
		{
			type: "event",
			event: {
				actor: "human",
				sessionId: session.session.id,
				turnId: item.turnId,
				type: "message_submitted",
				messageId: item.messageId,
				queueItemId: item.id,
				text: "hello",
				placement: "end",
				admission: "running",
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 1, running: { ...item, state: "running" }, waiting: [] },
			},
		},
		{
			type: "event",
			event: {
				actor: "human",
				modelRole: "user",
				sessionId: session.session.id,
				turnId: item.turnId,
				type: "message_delivered",
				messageId: item.messageId,
				text: "hello",
			},
		},
		{
			type: "conversation",
			id: "entry-user",
			parentId: null,
			turnId: item.turnId,
			messageId: item.messageId,
			message: { role: "user", content: "hello" },
		},
		...scopedExtra,
		...(state === "cancelling"
			? ([
					{
						type: "event",
						event: {
							actor: "human",
							sessionId: session.session.id,
							turnId: item.turnId,
							type: "turn_cancel_requested",
						},
					},
					{
						type: "event",
						event: {
							actor: "process",
							sessionId: session.session.id,
							type: "queue_changed",
							queue: { revision: 2, running: item, waiting: [] },
						},
					},
				] satisfies Payload[])
			: []),
	]);
	return session;
}

async function seedCancellingWithWaiting(store: SessionStore) {
	const session = await seedRunning(store, [], "cancelling");
	const running: Protocol.QueueItem = {
		id: "queue-1",
		sessionId: session.session.id,
		turnId: "turn-1",
		messageId: "message-1",
		text: "hello",
		state: "cancelling",
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
	const waiting: Protocol.QueueItem = {
		id: "queue-2",
		sessionId: session.session.id,
		turnId: "turn-2",
		messageId: "message-2",
		text: "next",
		state: "waiting",
		submittedAt: "2026-01-01T00:00:01.000Z",
	};
	await session.log.append([
		{
			type: "event",
			event: {
				actor: "human",
				sessionId: session.session.id,
				turnId: waiting.turnId,
				type: "message_submitted",
				messageId: waiting.messageId,
				queueItemId: waiting.id,
				text: waiting.text,
				placement: "end",
				admission: "waiting",
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 3, running, waiting: [waiting] },
			},
		},
	]);
	return { session, waiting };
}

function controlledFactory(options: { pauseAfterDelta?: boolean; pauseAfterAbort?: boolean } = {}): {
	factory: NonNullable<DaemonOptions["harnessFactory"]>;
	initials: string[];
	inputs: string[];
	started(index: number): Promise<void>;
	deltaSeen(index: number): Promise<void>;
	finished(index: number): Promise<void>;
	release(index: number): void;
	releaseCleanup(index: number): void;
} {
	const initials: string[] = [];
	const inputs: string[] = [];
	const starts: PromiseWithResolvers<void>[] = [];
	const deltas: PromiseWithResolvers<void>[] = [];
	const finishes: PromiseWithResolvers<void>[] = [];
	const releases: PromiseWithResolvers<void>[] = [];
	const cleanupReleases: PromiseWithResolvers<void>[] = [];
	const factory = (initial: Engine.HarnessState): Harness => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			async *send(input, signal) {
				const index = initials.length;
				initials.push(input.initial.text);
				inputs.push(input.initial.text);
				starts[index] ??= Promise.withResolvers<void>();
				deltas[index] ??= Promise.withResolvers<void>();
				finishes[index] ??= Promise.withResolvers<void>();
				releases[index] ??= Promise.withResolvers<void>();
				state.messages.push({ role: "user", content: input.initial.text });
				yield delivered(input.initial);
				starts[index].resolve();
				const messageId = randomUUID();
				const text = `answer:${input.initial.text}`;
				yield delta(input.initial, messageId, text);
				deltas[index].resolve();
				if (options.pauseAfterDelta) await releases[index].promise;
				if (!options.pauseAfterDelta) await Promise.race([releases[index].promise, waitForAbort(signal)]);
				if (signal?.aborted) {
					cleanupReleases[index] ??= Promise.withResolvers<void>();
					if (options.pauseAfterAbort) await cleanupReleases[index].promise;
					yield { actor: "process", sessionId: input.initial.sessionId, turnId: input.initial.turnId, type: "aborted" };
					finishes[index].resolve();
					yield end(input.initial);
					return;
				}
				state.messages.push({ role: "assistant", content: text, toolCalls: [], reasoning: [] });
				yield completed(input.initial, messageId);
				for (let steering = input.takeSteering(true); steering; steering = input.takeSteering(true)) {
					inputs.push(steering.text);
					state.messages.push({ role: "user", content: steering.text });
					yield delivered(steering);
					const steeringId = randomUUID();
					const steeringText = `answer:${steering.text}`;
					yield delta(steering, steeringId, steeringText);
					state.messages.push({ role: "assistant", content: steeringText, toolCalls: [], reasoning: [] });
					yield completed(steering, steeringId);
				}
				finishes[index].resolve();
				yield end(input.initial);
			},
		};
	};
	return {
		factory,
		initials,
		inputs,
		started: async (index) => {
			while (!starts[index]) await new Promise<void>((resolve) => setImmediate(resolve));
			return starts[index].promise;
		},
		deltaSeen: async (index) => {
			while (!deltas[index]) await new Promise<void>((resolve) => setImmediate(resolve));
			return deltas[index].promise;
		},
		finished: async (index) => {
			while (!finishes[index]) await new Promise<void>((resolve) => setImmediate(resolve));
			return finishes[index].promise;
		},
		release: (index) => {
			releases[index] ??= Promise.withResolvers<void>();
			releases[index].resolve();
		},
		releaseCleanup: (index) => {
			cleanupReleases[index] ??= Promise.withResolvers<void>();
			cleanupReleases[index].resolve();
		},
	};
}

function delivered(message: Engine.UserMessage): Protocol.MessageDeliveredEvent {
	return {
		actor: "human",
		modelRole: "user",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "message_delivered",
		messageId: message.messageId,
		text: message.text,
	};
}

function delta(message: Engine.UserMessage, messageId: string, text: string): Protocol.MessageDeltaEvent {
	return {
		actor: "agent",
		modelRole: "assistant",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "message_delta",
		messageId,
		offset: 0,
		text,
	};
}

function completed(message: Engine.UserMessage, messageId: string): Protocol.AssistantMessageCompletedEvent {
	return {
		actor: "agent",
		modelRole: "assistant",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "assistant_message_completed",
		messageId,
		reason: "completed",
	};
}

function end(message: Engine.UserMessage): Protocol.EndEvent {
	return { actor: "process", sessionId: message.sessionId, turnId: message.turnId, type: "end" };
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

async function startServer(
	t: TestContext,
	harnessFactory: NonNullable<DaemonOptions["harnessFactory"]>,
	options: Partial<DaemonOptions> = {},
	autoClose = true,
): Promise<{ url: string; close: () => Promise<void> }> {
	const sessionDir = options.sessionDir ?? (await mkdtemp(join(tmpdir(), "ker-daemon-")));
	if (!options.sessionDir) t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const server = createDaemon({
		cwd: "/project",
		projectRoot: "/project",
		sessionDir,
		harnessFactory,
		eventTailSize: options.eventTailSize,
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	const close = async () => {
		await server.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	};
	if (autoClose) t.after(close);
	return { url: `http://127.0.0.1:${(address as AddressInfo).port}`, close };
}

async function createSession(url: string): Promise<Protocol.SessionDescriptor> {
	const response = await localFetch(`${url}/sessions`, { method: "POST" });
	assert.equal(response.status, 201);
	return readJson(response.body);
}

async function getSnapshot(url: string, sessionId: string): Promise<Protocol.SessionSnapshot> {
	const response = await localFetch(`${url}/sessions/${sessionId}`);
	assert.equal(response.status, 200);
	return readJson(response.body);
}

async function prompt(
	url: string,
	sessionId: string,
	text: string,
	placement: Protocol.Placement = { type: "end" },
): Promise<Protocol.PromptAdmission> {
	const response = await rawPrompt(url, sessionId, text, placement);
	assert.equal(response.status, 202);
	return readJson(response.body);
}

function rawPrompt(url: string, sessionId: string, text: string, placement: Protocol.Placement): Promise<TestResponse> {
	return localFetch(`${url}/sessions/${sessionId}/prompts`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			text,
			placement: placement.type,
			turnId: placement.type === "end" ? undefined : placement.turnId,
		}),
	});
}

async function waitForTerminal(url: string, sessionId: string, turnId: string): Promise<void> {
	while (true) {
		const snapshot = await getSnapshot(url, sessionId);
		const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
		if (turn && turn.status !== "running" && turn.status !== "cancelling" && turn.status !== "waiting") return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

interface TestResponse {
	status: number;
	body: IncomingMessage;
}

function localFetch(
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<TestResponse> {
	return new Promise((resolve, reject) => {
		const req = request(url, { method: init?.method, headers: { ...init?.headers, host: LOCAL_HOST } }, (res) =>
			resolve({ status: res.statusCode ?? 0, body: res }),
		);
		req.on("error", reject);
		req.end(init?.body);
	});
}

async function readJson<T>(body: AsyncIterable<Uint8Array>): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of body) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function* readEnvelopes(body: AsyncIterable<Uint8Array>): AsyncGenerator<Protocol.EventEnvelope> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const data = frame.match(/^data: (.+)$/m)?.[1];
			if (data) yield JSON.parse(data) as Protocol.EventEnvelope;
		}
	}
}

async function readUntil(
	frames: AsyncIterator<Protocol.EventEnvelope>,
	matches: (event: Protocol.Event) => boolean,
): Promise<Protocol.EventEnvelope> {
	while (true) {
		const next = await frames.next();
		assert.equal(next.done, false);
		if (matches(next.value.event)) return next.value;
	}
}
