import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { createDaemon, type DaemonOptions, type Harness } from "../src/index.ts";
import { type Payload, SessionStore, type StoredRecord } from "../src/store.ts";

const LOCAL_HOST = "127.0.0.1:5537";
const PRUNED_OUTPUT_PLACEHOLDER =
	"[Old tool output removed to free context space. Re-read the file or re-run the command if you still need it.]";

test("creates and lists explicit durable sessions", async (t) => {
	const running = await startServer(t, immediateFactory());
	const first = await createSession(running.url);
	const second = await createSession(running.url);
	const response = await localFetch(`${running.url}/sessions?cwd=${encodeURIComponent(process.cwd())}`);
	const listed = await readJson<{ sessions: Protocol.SessionDescriptor[] }>(response.body);

	assert.equal(response.status, 200);
	assert.deepEqual(
		listed.sessions.map((session) => session.id),
		[first.id, second.id],
	);
	assert(listed.sessions.every((session) => session.cwd === process.cwd()));
	assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 404);
});

test("creates, filters, and restores sessions from multiple projects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-daemon-projects-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionDir = join(root, "sessions");
	const projectA = join(root, "project-a");
	const cwdA = join(projectA, "nested");
	const otherCwdA = join(projectA, "other");
	const projectB = join(root, "project-b");
	await Promise.all([
		mkdir(join(projectA, ".git"), { recursive: true }),
		mkdir(cwdA, { recursive: true }),
		mkdir(otherCwdA, { recursive: true }),
		mkdir(projectB, { recursive: true }),
	]);
	const first = await startServer(t, immediateFactory(), { sessionDir }, false);
	const sessionA = await createSession(first.url, cwdA);
	const otherSessionA = await createSession(first.url, otherCwdA);
	const sessionB = await createSession(first.url, projectB);
	const canonicalRoot = await realpath(root);
	const canonicalProjectA = join(canonicalRoot, "project-a");
	const canonicalCwdA = join(canonicalProjectA, "nested");
	const canonicalOtherCwdA = join(canonicalProjectA, "other");
	const canonicalProjectB = join(canonicalRoot, "project-b");

	assert.equal(sessionA.cwd, canonicalCwdA);
	assert.equal(sessionA.projectRoot, canonicalProjectA);
	assert.equal(sessionB.cwd, canonicalProjectB);
	assert.equal(sessionB.projectRoot, canonicalProjectB);
	const scopedResponse = await localFetch(`${first.url}/sessions?cwd=${encodeURIComponent(cwdA)}`);
	const scoped = await readJson<Protocol.ListSessionsResponse>(scopedResponse.body);
	assert.deepEqual(
		scoped.sessions.map((session) => session.id),
		[sessionA.id],
	);
	const allResponse = await localFetch(`${first.url}/sessions?scope=all`);
	const all = await readJson<Protocol.ListSessionsResponse>(allResponse.body);
	assert.deepEqual(
		all.sessions.map((session) => session.id),
		[sessionA.id, otherSessionA.id, sessionB.id],
	);
	await first.close();

	const restoredCwds: string[] = [];
	const factory = immediateFactory();
	const second = await startServer(
		t,
		(state, cwd) => {
			restoredCwds.push(cwd);
			return factory(state, cwd);
		},
		{ sessionDir },
		false,
	);
	const restoredResponse = await localFetch(`${second.url}/sessions?scope=all`);
	const restored = await readJson<Protocol.ListSessionsResponse>(restoredResponse.body);
	assert.deepEqual(
		new Set(restored.sessions.map((session) => session.id)),
		new Set([sessionA.id, otherSessionA.id, sessionB.id]),
	);
	assert.deepEqual(restoredCwds, []);
	await getSnapshot(second.url, sessionA.id);
	await getSnapshot(second.url, otherSessionA.id);
	await getSnapshot(second.url, sessionB.id);
	assert.deepEqual(new Set(restoredCwds), new Set([canonicalCwdA, canonicalOtherCwdA, canonicalProjectB]));
	const retargetedResponse = await localFetch(
		`${second.url}/sessions/${sessionA.id}?cwd=${encodeURIComponent(projectB)}`,
	);
	const retargeted = await readJson<Protocol.SessionSnapshot>(retargetedResponse.body);
	assert.equal(retargeted.session.cwd, canonicalCwdA);
	const rejectedPrompt = await rawPrompt(second.url, sessionA.id, { text: "hello", cwd: projectB });
	assert.equal(rejectedPrompt.status, 400);
	assert.deepEqual(await readJson(rejectedPrompt.body), { code: "invalid_prompt" });
	const admitted = await prompt(second.url, sessionA.id, "hello");
	await waitForTerminal(second.url, sessionA.id, admitted.turnId);
	await second.close();
});

test("rejects invalid session cwd and listing scopes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-daemon-invalid-cwd-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "file");
	await writeFile(file, "not a directory");
	const running = await startServer(t, immediateFactory());
	const invalidBodies: Array<Protocol.CreateSessionRequest | object> = [
		{},
		{ cwd: root, extra: true },
		{ cwd: "relative" },
		{ cwd: join(root, "missing") },
		{ cwd: file },
	];
	for (const body of invalidBodies) {
		const response = await localFetch(`${running.url}/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await readJson(response.body), { code: "invalid_cwd" });
	}
	const missing = await localFetch(`${running.url}/sessions`, { method: "POST" });
	assert.equal(missing.status, 415);

	for (const query of ["", "?scope=project", `?scope=all&cwd=${encodeURIComponent(root)}`, "?extra=true"]) {
		const response = await localFetch(`${running.url}/sessions${query}`);
		assert.equal(response.status, 400);
		assert.deepEqual(await readJson(response.body), { code: "invalid_scope" });
	}
	for (const cwd of ["relative", join(root, "missing"), file]) {
		const response = await localFetch(`${running.url}/sessions?cwd=${encodeURIComponent(cwd)}`);
		assert.equal(response.status, 400);
		assert.deepEqual(await readJson(response.body), { code: "invalid_cwd" });
	}
});

test("keeps healthy sessions available when another session log is unreadable", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-malformed-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const malformed = await store.create(process.cwd());
	const healthy = await store.create(process.cwd());
	const original = await readFile(malformed.log.path, "utf8");
	await writeFile(malformed.log.path, `${original}not-json\n{"also":"bad"}`);
	const running = await startServer(t, immediateFactory(), { sessionDir });

	const health = await localFetch(`${running.url}/health`);
	assert.equal(health.status, 200);
	const listedResponse = await localFetch(`${running.url}/sessions?scope=all`);
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

test("scoped listing hides unreadable sessions from other project buckets", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-daemon-unreadable-scope-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionDir = join(root, "sessions");
	const projectA = join(root, "project-a");
	const projectB = join(root, "project-b");
	await Promise.all([
		mkdir(join(projectA, ".git"), { recursive: true }),
		mkdir(join(projectB, ".git"), { recursive: true }),
	]);
	const store = new SessionStore({ baseDir: sessionDir });
	const malformed = await store.create(projectA);
	const healthy = await store.create(projectB);
	const original = await readFile(malformed.log.path, "utf8");
	await writeFile(malformed.log.path, `${original}not-json\n`);
	const running = await startServer(t, immediateFactory(), { sessionDir });

	const projectBResponse = await localFetch(`${running.url}/sessions?cwd=${encodeURIComponent(projectB)}`);
	const projectBListing = await readJson<Protocol.ListSessionsResponse>(projectBResponse.body);
	assert.deepEqual(
		projectBListing.sessions.map((session) => session.id),
		[healthy.session.id],
	);
	assert.deepEqual(projectBListing.unreadable, []);

	const projectAResponse = await localFetch(`${running.url}/sessions?cwd=${encodeURIComponent(projectA)}`);
	const projectAListing = await readJson<Protocol.ListSessionsResponse>(projectAResponse.body);
	assert.deepEqual(projectAListing.sessions, []);
	assert.equal(projectAListing.unreadable[0]?.id, malformed.session.id);
});

test("different sessions run concurrently while each session keeps FIFO order", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const firstSession = await createSession(running.url);
	const secondSession = await createSession(running.url);

	const first = await prompt(running.url, firstSession.id, "A");
	assert.equal(first.status, "running");
	await controlled.started(0);
	const second = await prompt(running.url, secondSession.id, "B");
	const third = await prompt(running.url, firstSession.id, "A2");
	assert.equal(second.status, "running");
	assert.equal(third.status, "waiting");
	assert.equal(second.queue.revision, 1);
	assert.equal(third.queue.revision, first.queue.revision + 1);
	assert.deepEqual(
		third.queue.waiting.flatMap((item) => (item.kind === "prompt" ? [item.text] : [])),
		["A2"],
	);
	assert.equal("sessionId" in third.queue.waiting[0], false);
	await controlled.started(1);

	controlled.release(1);
	await controlled.finished(1);
	assert.equal(
		await Promise.race([controlled.started(2).then(() => "started"), Promise.resolve("waiting")]),
		"waiting",
	);
	controlled.release(0);
	await controlled.started(2);
	controlled.release(2);
	await controlled.finished(2);
	assert.deepEqual(controlled.initials, ["A", "B", "A2"]);
});

test("session event streams publish only their own queue revisions", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const firstSession = await createSession(running.url);
	const secondSession = await createSession(running.url);
	const firstSnapshot = await getSnapshot(running.url, firstSession.id);
	const secondSnapshot = await getSnapshot(running.url, secondSession.id);
	const firstStream = await localFetch(
		`${running.url}/sessions/${firstSession.id}/events?epoch=${firstSnapshot.cursor.epoch}&sequence=${firstSnapshot.cursor.sequence}`,
	);
	const secondStream = await localFetch(
		`${running.url}/sessions/${secondSession.id}/events?epoch=${secondSnapshot.cursor.epoch}&sequence=${secondSnapshot.cursor.sequence}`,
	);
	const firstFrames = readEnvelopes(firstStream.body)[Symbol.asyncIterator]();
	const secondFrames = readEnvelopes(secondStream.body)[Symbol.asyncIterator]();

	await prompt(running.url, firstSession.id, "A");
	await prompt(running.url, secondSession.id, "B");
	const firstQueue = await readUntil(firstFrames, (event) => event.type === "queue_changed");
	const secondQueue = await readUntil(secondFrames, (event) => event.type === "queue_changed");
	assert.equal(firstQueue.event.sessionId, firstSession.id);
	assert.equal(secondQueue.event.sessionId, secondSession.id);
	assert.equal(firstQueue.event.type, "queue_changed");
	assert.equal(secondQueue.event.type, "queue_changed");
	if (firstQueue.event.type === "queue_changed") {
		assert.equal(
			firstQueue.event.queue.running?.kind === "prompt" ? firstQueue.event.queue.running.text : undefined,
			"A",
		);
	}
	if (secondQueue.event.type === "queue_changed") {
		assert.equal(
			secondQueue.event.queue.running?.kind === "prompt" ? secondQueue.event.queue.running.text : undefined,
			"B",
		);
	}

	controlled.release(0);
	controlled.release(1);
	await Promise.all([controlled.finished(0), controlled.finished(1)]);
	await firstFrames.return?.(undefined);
	await secondFrames.return?.(undefined);
});

test("active cancellation in one session does not delay another session", async (t) => {
	const controlled = controlledFactory({ pauseAfterAbort: true });
	const running = await startServer(t, controlled.factory);
	const firstSession = await createSession(running.url);
	const secondSession = await createSession(running.url);
	const first = await prompt(running.url, firstSession.id, "A");
	await controlled.deltaSeen(0);
	const second = await prompt(running.url, secondSession.id, "B");
	await controlled.deltaSeen(1);

	const cancellation = await localFetch(`${running.url}/sessions/${firstSession.id}/turns/${first.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(cancellation.status, 202);
	await readJson(cancellation.body);
	controlled.release(1);
	await controlled.finished(1);
	await waitForTerminal(running.url, secondSession.id, second.turnId);
	assert.equal((await getSnapshot(running.url, secondSession.id)).queue.running, undefined);
	assert.equal((await getSnapshot(running.url, firstSession.id)).queue.running?.state, "cancelling");

	controlled.releaseCleanup(0);
	await controlled.finished(0);
});

test("same-session prompts run in admission order", async (t) => {
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory);
	const session = await createSession(running.url);

	await prompt(running.url, session.id, "A");
	await controlled.started(0);
	await prompt(running.url, session.id, "B");
	const third = await prompt(running.url, session.id, "C");
	assert.equal(third.status, "waiting");

	controlled.release(0);
	await controlled.started(1);
	controlled.release(1);
	await controlled.started(2);
	controlled.release(2);
	await controlled.finished(2);
	assert.deepEqual(controlled.initials, ["A", "B", "C"]);
});

test("rejects obsolete prompt fields and removes the project queue route", async (t) => {
	const running = await startServer(t, immediateFactory());
	const session = await createSession(running.url);
	for (const body of [
		{ text: "hello", placement: "end" },
		{ text: "hello", turnId: "turn-1" },
		{ text: "hello", extra: true },
		{ text: "  " },
	]) {
		const response = await rawPrompt(running.url, session.id, body);
		assert.equal(response.status, 400);
		assert.deepEqual(await readJson(response.body), { code: "invalid_prompt" });
	}
	assert.equal((await localFetch(`${running.url}/queue`)).status, 404);
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

test("snapshots preserve cumulative usage and current context across restart", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-usage-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const first = await startServer(t, accountingFactory(), { sessionDir }, false);
	const session = await createSession(first.url);
	const completed = await prompt(first.url, session.id, "hello");
	await waitForTerminal(first.url, session.id, completed.turnId);
	const filtered = await prompt(first.url, session.id, "filtered");
	await waitForTerminal(first.url, session.id, filtered.turnId);
	const live = await getSnapshot(first.url, session.id);

	assert.deepEqual(live.model, {
		provider: "openai",
		id: "gpt-5.4-mini",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
	});
	assert.deepEqual(live.usage, {
		contextTokens: 19,
		cumulative: {
			input: 18,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			reasoning: 3,
			total: 30,
		},
	});
	await first.close();

	const second = await startServer(t, accountingFactory(), { sessionDir }, false);
	assert.deepEqual((await getSnapshot(second.url, session.id)).usage, live.usage);
	await second.close();
});

test("multi-step usage is counted once per provider call and restores across restart", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-multi-step-usage-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const first = await startServer(t, multiStepAccountingFactory(), { sessionDir }, false);
	const session = await createSession(first.url);
	const admitted = await prompt(first.url, session.id, "calculate");
	await waitForTerminal(first.url, session.id, admitted.turnId);
	const live = await getSnapshot(first.url, session.id);

	assert.deepEqual(live.usage, {
		contextTokens: 50,
		cumulative: {
			input: 12,
			output: 14,
			cacheRead: 16,
			cacheWrite: 18,
			reasoning: 6,
			total: 60,
		},
	});
	await first.close();

	const second = await startServer(t, multiStepAccountingFactory(), { sessionDir }, false);
	assert.deepEqual((await getSnapshot(second.url, session.id)).usage, live.usage);
	await second.close();
});

test("snapshots keep unknown models without guessed capacity metadata", async (t) => {
	const running = await startServer(t, accountingFactory("custom-model"));
	const session = await createSession(running.url);
	const admitted = await prompt(running.url, session.id, "hello");
	await waitForTerminal(running.url, session.id, admitted.turnId);

	assert.deepEqual((await getSnapshot(running.url, session.id)).model, {
		provider: "openai",
		id: "custom-model",
	});
});

test("restored sessions configure their harness with the recorded cwd", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-cwd-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const cwd = join(sessionDir, "project", "nested");
	await mkdir(cwd, { recursive: true });
	const canonicalCwd = await realpath(cwd);
	const store = new SessionStore({ baseDir: sessionDir });
	const session = await store.create(cwd);
	const captured: string[] = [];
	const factory = immediateFactory();
	const running = await startServer(
		t,
		(state, cwd) => {
			captured.push(cwd);
			return factory(state, cwd);
		},
		{ sessionDir },
	);

	await getSnapshot(running.url, session.session.id);
	assert.deepEqual(captured, [canonicalCwd]);
});

test("restart marks an active turn interrupted without repeating its work", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-interrupted-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
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
	const store = new SessionStore({ baseDir: sessionDir });
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
	const store = new SessionStore({ baseDir: sessionDir });
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
	const store = new SessionStore({ baseDir: sessionDir });
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

test("restart recovers and promotes each session independently", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-multi-recovery-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const first = await seedCancellingWithWaiting(store);
	const second = await seedCancellingWithWaiting(store);
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory, { sessionDir });
	await Promise.all([controlled.started(0), controlled.started(1)]);

	for (const seeded of [first, second]) {
		const snapshot = await getSnapshot(running.url, seeded.session.session.id);
		assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "aborted");
		assert.equal(snapshot.turns.find((turn) => turn.id === seeded.waiting.turnId)?.status, "running");
	}
	controlled.release(0);
	controlled.release(1);
	await Promise.all([controlled.finished(0), controlled.finished(1)]);
});

test("restart drains stale waiting prompts instead of running them", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-expired-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedWaiting(store, [{ text: "stale", submittedAt: "2026-01-01T00:00:00.000Z" }]);
	const seededLines = (await readFile(seeded.session.log.path, "utf8")).trimEnd().split("\n").length;
	const running = await startServer(t, passiveFactory([]), { sessionDir, recoveryWindowMinutes: 0 });

	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(snapshot.queue.running, undefined);
	assert.deepEqual(snapshot.queue.waiting, []);
	assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "expired");
	const lines = (await readFile(seeded.session.log.path, "utf8")).trimEnd().split("\n");
	const events = lines
		.slice(seededLines)
		.map((line) => JSON.parse(line) as StoredRecord)
		.flatMap((record) => (record.type === "event" ? [record.event] : []));
	assert.deepEqual(
		events.map((event) => event.type),
		["message_undelivered", "turn_terminal", "end", "queue_changed"],
	);
	assert.deepEqual(events[0], {
		actor: "process",
		sessionId: seeded.session.session.id,
		turnId: "turn-1",
		type: "message_undelivered",
		messageId: "message-1",
		text: "stale",
		reason: "expired",
	});
	const terminal = events[1];
	assert.equal(terminal.type, "turn_terminal");
	if (terminal.type === "turn_terminal") assert.equal(terminal.reason, "expired");
	const queue = events.at(-1);
	assert.equal(queue?.type, "queue_changed");
	if (queue?.type === "queue_changed") {
		assert.equal(queue.queue.running, undefined);
		assert.deepEqual(queue.queue.waiting, []);
	}
});

test("restart expires a waiting compaction without emitting a prompt delivery failure", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-expired-compaction-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedWaitingCompaction(store);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), {
		sessionDir,
		recoveryWindowMinutes: 0,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});

	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === seeded.item.turnId)?.status, "expired");
	assert.equal(snapshot.queue.running, undefined);
	assert.deepEqual(snapshot.queue.waiting, []);
	assert.equal(captured.length, 1);

	const stored = await store.loadSession(seeded.session.log.path);
	const events = stored.records.flatMap((record) =>
		record.type === "event" && "turnId" in record.event && record.event.turnId === seeded.item.turnId
			? [record.event]
			: [],
	);
	assert.deepEqual(
		events.map((event) => event.type),
		["compaction_submitted", "turn_terminal", "end"],
	);
	assert.equal(
		events.some((event) => event.type === "message_undelivered"),
		false,
	);
	assert.equal(
		stored.records.some((record) => record.type === "compaction"),
		false,
	);
});

test("a recovery window long enough resumes stale waiting prompts", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-resume-window-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedWaiting(store, [{ text: "stale", submittedAt: "2026-01-01T00:00:00.000Z" }]);
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory, {
		sessionDir,
		recoveryWindowMinutes: Number.MAX_SAFE_INTEGER,
	});

	await controlled.started(0);
	controlled.release(0);
	await controlled.finished(0);
	await waitForTerminal(running.url, seeded.session.session.id, "turn-1");
	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "completed");
	assert.deepEqual(controlled.initials, ["stale"]);
});

test("restart drains only expired prompts and keeps survivor order", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-mixed-expiry-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const recent = new Date(Date.now() - 60_000).toISOString();
	const seeded = await seedWaiting(store, [
		{ text: "stale", submittedAt: "2026-01-01T00:00:00.000Z" },
		{ text: "fresh-1", submittedAt: recent },
		{ text: "fresh-2", submittedAt: recent },
	]);
	const controlled = controlledFactory();
	const running = await startServer(t, controlled.factory, { sessionDir, recoveryWindowMinutes: 60 });

	await controlled.started(0);
	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "expired");
	assert.equal(snapshot.queue.running?.kind === "prompt" ? snapshot.queue.running.text : undefined, "fresh-1");
	assert.deepEqual(
		snapshot.queue.waiting.flatMap((item) => (item.kind === "prompt" ? [item.text] : [])),
		["fresh-2"],
	);
	controlled.release(0);
	await controlled.started(1);
	controlled.release(1);
	await controlled.finished(1);
	assert.deepEqual(controlled.initials, ["fresh-1", "fresh-2"]);
});

test("a drained turn stays expired across another restart", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-expired-replay-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedWaiting(store, [{ text: "stale", submittedAt: "2026-01-01T00:00:00.000Z" }]);
	const first = await startServer(t, passiveFactory([]), { sessionDir, recoveryWindowMinutes: 0 }, false);
	assert.equal(
		(await getSnapshot(first.url, seeded.session.session.id)).turns.find((turn) => turn.id === "turn-1")?.status,
		"expired",
	);
	await first.close();

	const second = await startServer(t, passiveFactory([]), { sessionDir, recoveryWindowMinutes: 0 }, false);
	const snapshot = await getSnapshot(second.url, seeded.session.session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "expired");
	assert.equal(snapshot.queue.running, undefined);
	assert.deepEqual(snapshot.queue.waiting, []);
	await second.close();
});

test("restart drains stale waiting work before finalizing the interrupted turn", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-cancelling-expiry-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedCancellingWithWaiting(store);
	const running = await startServer(t, passiveFactory([]), { sessionDir, recoveryWindowMinutes: 0 });

	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === "turn-1")?.status, "aborted");
	assert.equal(snapshot.turns.find((turn) => turn.id === seeded.waiting.turnId)?.status, "expired");
	assert.equal(snapshot.queue.running, undefined);
	assert.deepEqual(snapshot.queue.waiting, []);
});

test("restart constructs harnesses only for sessions with pending work", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-lazy-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const first = await startServer(t, immediateFactory(), { sessionDir }, false);
	const idleSession = await createSession(first.url);
	const admitted = await prompt(first.url, idleSession.id, "done");
	await waitForTerminal(first.url, idleSession.id, admitted.turnId);
	await first.close();
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedWaiting(store, [{ text: "pending", submittedAt: "2026-01-01T00:00:00.000Z" }]);

	let constructions = 0;
	const factory = immediateFactory();
	const second = await startServer(
		t,
		(state, cwd) => {
			constructions++;
			return factory(state, cwd);
		},
		{ sessionDir },
		false,
	);
	await waitForTerminal(second.url, seeded.session.session.id, "turn-1");
	assert.equal(constructions, 1);
	const snapshot = await getSnapshot(second.url, idleSession.id);
	assert.equal(constructions, 2);
	assert.deepEqual(
		snapshot.messages.map((message) => message.text),
		["answer:done"],
	);
	assert(snapshot.entries.length >= 2);
	await second.close();
});

test("listing after restart reads no session bodies", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-catalog-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const first = await startServer(t, immediateFactory(), { sessionDir }, false);
	const completed = await createSession(first.url);
	const admitted = await prompt(first.url, completed.id, "done");
	await waitForTerminal(first.url, completed.id, admitted.turnId);
	const bare = await createSession(first.url);
	await first.close();

	const second = await startServer(
		t,
		() => {
			throw new Error("Idle sessions must not construct a harness");
		},
		{ sessionDir },
		false,
	);
	const listed = await readJson<Protocol.ListSessionsResponse>(
		(await localFetch(`${second.url}/sessions?scope=all`)).body,
	);
	assert.deepEqual(new Set(listed.sessions.map((session) => session.id)), new Set([completed.id, bare.id]));
	assert.deepEqual(listed.unreadable, []);
	await second.close();
});

test("corruption behind an idle-looking tail surfaces at attach", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-hidden-corruption-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const session = await store.create(process.cwd());
	const tail = JSON.stringify({
		version: 3,
		recordId: "tail",
		previousRecordId: "missing",
		at: "2026-01-01T00:00:00.000Z",
		type: "event",
		event: {
			actor: "process",
			sessionId: session.session.id,
			type: "queue_changed",
			queue: { revision: 9, waiting: [] },
		},
	});
	await appendFile(session.log.path, `not-json\n${tail}\n`);
	const running = await startServer(t, immediateFactory(), { sessionDir });

	const before = await readJson<Protocol.ListSessionsResponse>(
		(await localFetch(`${running.url}/sessions?scope=all`)).body,
	);
	assert.deepEqual(
		before.sessions.map((listed) => listed.id),
		[session.session.id],
	);
	assert.deepEqual(before.unreadable, []);

	const snapshot = await localFetch(`${running.url}/sessions/${session.session.id}`);
	assert.equal(snapshot.status, 500);
	assert.equal((await readJson<{ code: string }>(snapshot.body)).code, "session_unreadable");

	const after = await readJson<Protocol.ListSessionsResponse>(
		(await localFetch(`${running.url}/sessions?scope=all`)).body,
	);
	assert.deepEqual(after.sessions, []);
	assert.equal(after.unreadable[0]?.id, session.session.id);
});

test("manual compaction validates instructions and reports a durable skip", async (t) => {
	const requests: Engine.CompactionRequest[] = [];
	const running = await startServer(t, compactionFactory(requests, "skipped"), {
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	const session = await createSession(running.url);

	for (const body of [{ instructions: "" }, { instructions: 1 }, { extra: true }]) {
		const invalid = await rawCompact(running.url, session.id, body);
		assert.equal(invalid.status, 400);
		assert.deepEqual(await readJson(invalid.body), { code: "invalid_compaction" });
	}
	const response = await rawCompact(running.url, session.id, { instructions: "preserve test failures" });
	assert.equal(response.status, 202);
	const admission = await readJson<Protocol.CompactionAdmission>(response.body);
	assert.equal(admission.status, "running");
	await waitForTerminal(running.url, session.id, admission.turnId);

	assert.equal(requests[0]?.instructions, "preserve test failures");
	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === admission.turnId)?.status, "completed");
	assert.equal(
		snapshot.entries.some((entry) => entry.role === "compaction"),
		false,
	);
});

test("rejects a compaction that does not shrink without recording or rebuilding", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-no-shrink-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const requests: Engine.CompactionRequest[] = [];
	const factory = compactionFactory(requests, { tokensBefore: 17, tokensAfter: 17 });
	let harnessCreations = 0;
	const running = await startServer(
		t,
		(initial, cwd) => {
			harnessCreations++;
			return factory(initial, cwd);
		},
		{
			sessionDir,
			compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
		},
	);
	const session = await createSession(running.url);
	const admittedPrompt = await prompt(running.url, session.id, "remember");
	await waitForTerminal(running.url, session.id, admittedPrompt.turnId);
	const response = await rawCompact(running.url, session.id, {});
	const admitted = await readJson<Protocol.CompactionAdmission>(response.body);
	await waitForTerminal(running.url, session.id, admitted.turnId);

	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === admitted.turnId)?.status, "error");
	assert.equal(harnessCreations, 1);
	const [catalog] = await store.scanCatalog();
	const stored = await store.loadSession(catalog.path);
	assert.equal(
		stored.records.some((record) => record.type === "compaction"),
		false,
	);
	const error = stored.records.find(
		(record) => record.type === "event" && record.event.type === "error" && record.event.turnId === admitted.turnId,
	);
	assert.equal(error?.type, "event");
	if (error?.type === "event" && error.event.type === "error") {
		assert.equal(error.event.message, "Compaction did not reduce the context (17 → 17 tokens)");
	}
});

test("applies the bounded watermark only to automatic compaction", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-watermark-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const requests: Engine.CompactionRequest[] = [];
	const factory = compactionFactory(requests, { tokensBefore: 17, tokensAfter: 6 });
	let harnessCreations = 0;
	const running = await startServer(
		t,
		(initial, cwd) => {
			harnessCreations++;
			return factory(initial, cwd);
		},
		{
			sessionDir,
			compaction: { enabled: true, reserveTokens: 271_990, keepRecentTokens: 1, prune: false },
		},
	);
	const session = await createSession(running.url);
	const promptAdmission = await prompt(running.url, session.id, "cross the threshold");
	await waitForCompactionAttempts(running.url, session.id, requests, 1);

	assert.equal(requests[0]?.contextWindow, 272_000);
	const afterAuto = await getSnapshot(running.url, session.id);
	const autoTurn = afterAuto.turns.find((turn) => turn.id !== promptAdmission.turnId);
	assert.equal(autoTurn?.status, "error");
	assert.equal(harnessCreations, 1);
	const afterAutoStored = await store.loadSession((await store.scanCatalog())[0].path);
	const autoError = afterAutoStored.records.find(
		(record) => record.type === "event" && record.event.type === "error" && record.event.turnId === autoTurn?.id,
	);
	assert.equal(autoError?.type, "event");
	if (autoError?.type === "event" && autoError.event.type === "error") {
		assert.equal(autoError.event.message, "Compacted context is still too close to the compaction threshold");
	}
	assert.equal(
		afterAutoStored.records.some((record) => record.type === "compaction"),
		false,
	);

	const response = await rawCompact(running.url, session.id, {});
	const manual = await readJson<Protocol.CompactionAdmission>(response.body);
	await waitForTerminal(running.url, session.id, manual.turnId);

	const afterManual = await getSnapshot(running.url, session.id);
	assert.equal(afterManual.turns.find((turn) => turn.id === manual.turnId)?.status, "completed");
	assert.equal(harnessCreations, 2);
	const afterManualStored = await store.loadSession((await store.scanCatalog())[0].path);
	assert.equal(afterManualStored.records.filter((record) => record.type === "compaction").length, 1);
});

test("a non-positive automatic trigger skips compaction while manual compaction still runs", async (t) => {
	const requests: Engine.CompactionRequest[] = [];
	const running = await startServer(t, compactionFactory(requests, "compacted"), {
		compaction: { enabled: true, reserveTokens: 272_000, keepRecentTokens: 1, prune: false },
	});
	const session = await createSession(running.url);
	const admittedPrompt = await prompt(running.url, session.id, "do not compact automatically");
	await waitForTerminal(running.url, session.id, admittedPrompt.turnId);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(requests.length, 0);
	const response = await rawCompact(running.url, session.id, {});
	const manual = await readJson<Protocol.CompactionAdmission>(response.body);
	await waitForTerminal(running.url, session.id, manual.turnId);

	assert.equal(requests.length, 1);
	assert.equal(
		(await getSnapshot(running.url, session.id)).turns.find((turn) => turn.id === manual.turnId)?.status,
		"completed",
	);
});

test("restart interrupts a compaction that crashed before its record was appended", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-crash-before-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedRunningCompaction(store, false);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), {
		sessionDir,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});

	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === seeded.item.turnId)?.status, "interrupted");
	assert.equal(snapshot.queue.running, undefined);
	assert.deepEqual(
		snapshot.entries.map((entry) => entry.role),
		["user"],
	);
	assert.deepEqual(
		captured.map((state) => state.messages.map((message) => message.role)),
		[["user"]],
	);

	const stored = await store.loadSession(seeded.session.log.path);
	const events = stored.records.flatMap((record) =>
		record.type === "event" && "turnId" in record.event && record.event.turnId === seeded.item.turnId
			? [record.event]
			: [],
	);
	assert.deepEqual(
		events.map((event) => event.type),
		["compaction_submitted", "interrupted", "turn_terminal", "end"],
	);
	assert.equal(
		stored.records.some((record) => record.type === "compaction"),
		false,
	);
	assert.equal(
		events.some((event) => event.type === "message_undelivered"),
		false,
	);
});

test("restart completes a compaction that crashed after its record was appended", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-crash-after-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedRunningCompaction(store, true);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), {
		sessionDir,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});

	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === seeded.item.turnId)?.status, "completed");
	assert.equal(snapshot.queue.running, undefined);
	assert.deepEqual(
		snapshot.entries.map((entry) => entry.role),
		["user", "compaction"],
	);
	assert.deepEqual(
		captured.map((state) => state.messages.map((message) => message.role)),
		[["developer", "user"]],
	);

	const stored = await store.loadSession(seeded.session.log.path);
	const events = stored.records.flatMap((record) =>
		record.type === "event" && "turnId" in record.event && record.event.turnId === seeded.item.turnId
			? [record.event]
			: [],
	);
	assert.deepEqual(
		events.map((event) => event.type),
		["compaction_submitted", "compacted", "turn_terminal", "end"],
	);
	assert.equal(
		events.some((event) => event.type === "interrupted"),
		false,
	);
	assert.equal(stored.records.filter((record) => record.type === "compaction").length, 1);
});

test("cancelling a running compaction leaves history and the harness untouched", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-cancel-running-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const started = Promise.withResolvers<void>();
	const initials: Engine.HarnessState[] = [];
	const factory: NonNullable<DaemonOptions["harnessFactory"]> = (initial) => {
		const state = structuredClone(initial);
		initials.push(structuredClone(initial));
		return {
			snapshot: () => structuredClone(state),
			async *compact(_input, signal) {
				started.resolve();
				await waitForAbort(signal);
				yield* [];
				return { kind: "aborted" };
			},
			async *send() {
				yield* [];
			},
		};
	};
	const running = await startServer(t, factory, {
		sessionDir,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	const session = await createSession(running.url);
	const response = await rawCompact(running.url, session.id, {});
	assert.equal(response.status, 202);
	const admission = await readJson<Protocol.CompactionAdmission>(response.body);
	await started.promise;

	const cancellation = await localFetch(`${running.url}/sessions/${session.id}/turns/${admission.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(cancellation.status, 202);
	await readJson(cancellation.body);
	await waitForTerminal(running.url, session.id, admission.turnId);

	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === admission.turnId)?.status, "aborted");
	assert.deepEqual(snapshot.entries, []);
	assert.equal(initials.length, 1);
	const [catalog] = await store.scanCatalog();
	const stored = await store.loadSession(catalog.path);
	assert.equal(
		stored.records.some((record) => record.type === "compaction"),
		false,
	);
	assert.equal(
		stored.records.some(
			(record) =>
				record.type === "event" &&
				record.event.type === "message_undelivered" &&
				record.event.turnId === admission.turnId,
		),
		false,
	);
});

test("cancelling a waiting compaction does not emit a prompt delivery failure or rebuild the harness", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-cancel-waiting-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const controlled = controlledFactory();
	let harnessCreations = 0;
	const running = await startServer(
		t,
		(initial, cwd) => {
			harnessCreations++;
			return controlled.factory(initial, cwd);
		},
		{
			sessionDir,
			compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
		},
	);
	const session = await createSession(running.url);
	const promptAdmission = await prompt(running.url, session.id, "hold");
	await controlled.started(0);
	const response = await rawCompact(running.url, session.id, {});
	assert.equal(response.status, 202);
	const admission = await readJson<Protocol.CompactionAdmission>(response.body);
	assert.equal(admission.status, "waiting");

	const cancellation = await localFetch(`${running.url}/sessions/${session.id}/turns/${admission.turnId}/cancel`, {
		method: "POST",
	});
	assert.equal(cancellation.status, 200);
	await readJson(cancellation.body);
	controlled.release(0);
	await controlled.finished(0);
	await waitForTerminal(running.url, session.id, promptAdmission.turnId);

	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === admission.turnId)?.status, "cancelled");
	assert.equal(harnessCreations, 1);
	const [catalog] = await store.scanCatalog();
	const stored = await store.loadSession(catalog.path);
	assert.equal(
		stored.records.some((record) => record.type === "compaction"),
		false,
	);
	assert.equal(
		stored.records.some(
			(record) =>
				record.type === "event" &&
				record.event.type === "message_undelivered" &&
				record.event.turnId === admission.turnId,
		),
		false,
	);
});

test("repeat compaction uses the latest summary and the next prompt persists no duplicate history", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-repeat-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const requests: Engine.CompactionRequest[] = [];
	const running = await startServer(t, compactionFactory(requests, "compacted"), {
		sessionDir,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	const session = await createSession(running.url);
	const firstPrompt = await prompt(running.url, session.id, "first");
	await waitForTerminal(running.url, session.id, firstPrompt.turnId);
	const firstResponse = await rawCompact(running.url, session.id, {});
	const firstCompaction = await readJson<Protocol.CompactionAdmission>(firstResponse.body);
	await waitForTerminal(running.url, session.id, firstCompaction.turnId);

	const secondPrompt = await prompt(running.url, session.id, "second");
	await waitForTerminal(running.url, session.id, secondPrompt.turnId);
	const beforeRepeat = await store.loadSession((await store.scanCatalog())[0].path);
	assert.deepEqual(
		beforeRepeat.records.flatMap((record) => (record.type === "conversation" ? [record.message.role] : [])),
		["user", "assistant", "user", "assistant"],
	);
	const secondResponse = await rawCompact(running.url, session.id, {});
	const secondCompaction = await readJson<Protocol.CompactionAdmission>(secondResponse.body);
	await waitForTerminal(running.url, session.id, secondCompaction.turnId);

	const thirdPrompt = await prompt(running.url, session.id, "third");
	await waitForTerminal(running.url, session.id, thirdPrompt.turnId);
	const thirdResponse = await rawCompact(running.url, session.id, {});
	const thirdCompaction = await readJson<Protocol.CompactionAdmission>(thirdResponse.body);
	await waitForTerminal(running.url, session.id, thirdCompaction.turnId);

	assert.equal(requests[0]?.previousSummary, undefined);
	assert.equal(requests[1]?.previousSummary, "summary-1");
	assert.equal(requests[2]?.previousSummary, "summary-2");
	const snapshot = await getSnapshot(running.url, session.id);
	assert.deepEqual(
		snapshot.entries.map((entry) => entry.role),
		["user", "assistant", "compaction", "user", "assistant", "compaction", "user", "assistant", "compaction"],
	);
});

test("automatic compaction stays latched until a prompt usage event rearms it", { timeout: 10_000 }, async (t) => {
	const requests: Engine.CompactionRequest[] = [];
	const running = await startServer(t, compactionFactory(requests, "skipped"), {
		compaction: { enabled: true, reserveTokens: 271_999, keepRecentTokens: 1, prune: false },
	});
	const session = await createSession(running.url);
	const first = await prompt(running.url, session.id, "first");
	await waitForCompactionAttempts(running.url, session.id, requests, 1);
	assert.equal(requests.length, 1);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(requests.length, 1);

	const second = await prompt(running.url, session.id, "second");
	assert.equal(second.status, "running");
	assert.equal(second.queue.running?.kind, "prompt");
	await waitForCompactionAttempts(running.url, session.id, requests, 2);

	const snapshot = await getSnapshot(running.url, session.id);
	assert.equal(snapshot.turns.find((turn) => turn.id === first.turnId)?.status, "completed");
	assert.equal(snapshot.turns.find((turn) => turn.id === second.turnId)?.status, "completed");
	assert.equal(requests.length, 2);
});

test("an over-ceiling idle session compacts before admitting its next prompt", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-rescue-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await store.create(process.cwd());
	const usage: Protocol.Usage = { input: 10, output: 7, cacheRead: 0, cacheWrite: 0, total: 17 };
	await seeded.log.append([
		{
			type: "conversation",
			id: "entry-user",
			parentId: null,
			turnId: "turn-old",
			message: { role: "user", content: "old request" },
		},
		{
			type: "conversation",
			id: "entry-assistant",
			parentId: "entry-user",
			turnId: "turn-old",
			message: {
				role: "assistant",
				content: "old response",
				provider: "openai",
				model: "gpt-5.4-mini",
				usage,
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: seeded.session.id,
				turnId: "turn-old",
				type: "usage",
				provider: "openai",
				model: "gpt-5.4-mini",
				usage,
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: seeded.session.id,
				type: "queue_changed",
				queue: { revision: 1, waiting: [] },
			},
		},
	]);
	const requests: Engine.CompactionRequest[] = [];
	const running = await startServer(t, compactionFactory(requests, "compacted"), {
		sessionDir,
		compaction: { enabled: true, reserveTokens: 271_990, keepRecentTokens: 1, prune: false },
	});

	const admitted = await prompt(running.url, seeded.session.id, "rescue me");
	assert.equal(admitted.status, "waiting");
	assert.equal(admitted.queue.running?.kind, "compaction");
	assert.equal(admitted.queue.waiting[0]?.kind, "prompt");
	await waitForTerminal(running.url, seeded.session.id, admitted.turnId);
	assert(requests.length >= 1);

	const [catalog] = await new SessionStore({ baseDir: sessionDir }).scanCatalog();
	const records = await new SessionStore({ baseDir: sessionDir }).loadSession(catalog.path);
	const events = records.records.flatMap((record) => (record.type === "event" ? [record.event] : []));
	const submittedCompaction = events.findIndex((event) => event.type === "compaction_submitted");
	const submittedPrompt = events.findIndex((event) => event.type === "message_submitted");
	assert(submittedCompaction !== -1 && submittedCompaction < submittedPrompt);
});

test(
	"automatic compaction runs after a ceiling-crossing prompt and keeps the transcript",
	{ timeout: 10_000 },
	async (t) => {
		const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-"));
		t.after(() => rm(sessionDir, { recursive: true, force: true }));
		const requests: Engine.CompactionRequest[] = [];
		const running = await startServer(t, compactionFactory(requests, "compacted"), {
			sessionDir,
			compaction: { enabled: true, reserveTokens: 271_990, keepRecentTokens: 1, prune: false },
		});
		const session = await createSession(running.url);
		const admitted = await prompt(running.url, session.id, "remember this");
		await waitForCompaction(running.url, session.id, admitted.turnId);

		const snapshot = await getSnapshot(running.url, session.id);
		assert.equal(snapshot.turns.find((turn) => turn.id === admitted.turnId)?.status, "completed");
		assert.deepEqual(
			snapshot.entries.map((entry) => entry.role),
			["user", "assistant", "compaction"],
		);
		const compacted = snapshot.entries.at(-1);
		assert.equal(compacted?.role, "compaction");
		assert.equal(requests.length, 1);
		const [catalog] = await new SessionStore({ baseDir: sessionDir }).scanCatalog();
		const records = await new SessionStore({ baseDir: sessionDir }).loadSession(catalog.path);
		const eventTypes = records.records.flatMap((record) => (record.type === "event" ? [record.event.type] : []));
		assert(eventTypes.indexOf("compaction_submitted") > eventTypes.indexOf("end"));
		assert.equal(
			records.records.some((record) => record.type === "compaction"),
			true,
		);
		assert.equal(catalog.idle, true);
	},
);

test("prunes old tool output before admission and avoids compaction below the threshold", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-prune-only-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedPrunableSession(store);
	const prune = Engine.pruneToolOutputs(seeded.messages);
	assert(prune);
	const threshold = Math.floor((prune.tokensBefore + prune.tokensAfter) / 2);
	const requests: Engine.CompactionRequest[] = [];
	const running = await startServer(t, compactionFactory(requests, "skipped"), {
		sessionDir,
		compaction: {
			enabled: true,
			reserveTokens: 272_000 - threshold,
			keepRecentTokens: 1,
			prune: true,
		},
	});

	const admission = await prompt(running.url, seeded.session.session.id, "continue");
	assert.equal(admission.status, "running");
	assert.equal(admission.queue.running?.kind, "prompt");
	await waitForTerminal(running.url, seeded.session.session.id, admission.turnId);

	assert.equal(requests.length, 0);
	const stored = await store.loadSession(seeded.session.log.path);
	assert.equal(stored.records.filter((record) => record.type === "prune").length, 1);
	assert.equal(stored.records.filter((record) => record.type === "event" && record.event.type === "pruned").length, 1);
	const snapshot = await getSnapshot(running.url, seeded.session.session.id);
	assert.equal(
		snapshot.entries.some((entry) => entry.role === "compaction"),
		false,
	);
	const [catalog] = await new SessionStore({ baseDir: sessionDir }).scanCatalog();
	assert.equal(catalog.idle, true);
});

test("queues compaction after pruning when the reduced context stays above the threshold", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-prune-then-compact-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedPrunableSession(store);
	const prune = Engine.pruneToolOutputs(seeded.messages);
	assert(prune);
	const requests: Engine.CompactionRequest[] = [];
	const running = await startServer(t, compactionFactory(requests, "skipped"), {
		sessionDir,
		compaction: {
			enabled: true,
			reserveTokens: 272_000 - (prune.tokensAfter - 1),
			keepRecentTokens: 1,
			prune: true,
		},
	});

	const admission = await prompt(running.url, seeded.session.session.id, "continue");
	assert.equal(admission.status, "waiting");
	assert.equal(admission.queue.running?.kind, "compaction");
	await waitForTerminal(running.url, seeded.session.session.id, admission.turnId);

	assert.equal(requests.length, 1);
	const stored = await store.loadSession(seeded.session.log.path);
	const pruneIndex = stored.records.findIndex((record) => record.type === "prune");
	const compactionIndex = stored.records.findIndex(
		(record) => record.type === "event" && record.event.type === "compaction_submitted",
	);
	assert(pruneIndex !== -1 && pruneIndex < compactionIndex);
});

test("builds the pruned harness before appending the durable record", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-prune-factory-failure-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const seeded = await seedPrunableSession(store);
	const base = compactionFactory([], "skipped");
	let harnessCreations = 0;
	const running = await startServer(
		t,
		(initial, cwd) => {
			harnessCreations++;
			if (harnessCreations === 2) throw new Error("factory failed");
			return base(initial, cwd);
		},
		{
			sessionDir,
			compaction: {
				enabled: true,
				reserveTokens: 271_999,
				keepRecentTokens: 1,
				prune: true,
			},
		},
	);

	const response = await rawPrompt(running.url, seeded.session.session.id, { text: "continue" });

	assert.equal(response.status, 500);
	assert.equal(harnessCreations, 2);
	const stored = await store.loadSession(seeded.session.log.path);
	assert.equal(
		stored.records.some((record) => record.type === "prune"),
		false,
	);
});

test("replay applies prune records and strips stale assistant usage", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-prune-replay-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const session = await store.create(process.cwd());
	const usage: Protocol.Usage = { input: 80_000, output: 1, cacheRead: 0, cacheWrite: 0, total: 80_001 };
	await session.log.append([
		{
			type: "conversation",
			id: "entry-assistant",
			parentId: null,
			turnId: "turn-old",
			message: {
				role: "assistant",
				content: "",
				toolCalls: [{ callId: "call-old", name: "read", arguments: "{}" }],
				provider: "openai",
				model: "gpt-5.4-mini",
				usage,
			},
		},
		{
			type: "conversation",
			id: "entry-tool",
			parentId: "entry-assistant",
			turnId: "turn-old",
			message: { role: "tool", toolCallId: "call-old", content: "large output" },
		},
		{ type: "prune", toolCallIds: ["call-old"], tokensBefore: 80_001, tokensAfter: 30 },
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 1, waiting: [] },
			},
		},
	]);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), { sessionDir });
	await getSnapshot(running.url, session.session.id);

	const assistant = captured[0]?.messages[0];
	assert.equal(assistant?.role, "assistant");
	if (assistant?.role === "assistant") assert.equal(assistant.usage, undefined);
	const tool = captured[0]?.messages[1];
	assert.equal(tool?.role, "tool");
	if (tool?.role === "tool") assert.equal(tool.content, PRUNED_OUTPUT_PLACEHOLDER);
});

test("ordered replay keeps pruned output through compaction in either record order", async (t) => {
	const liveProjection = Engine.applyPrune(
		[
			Engine.compactionSummaryMessage("summary"),
			{
				role: "assistant",
				content: "",
				toolCalls: [{ callId: "call-old", name: "read", arguments: "{}" }],
			},
			{ role: "tool", toolCallId: "call-old", content: "large output" },
		],
		["call-old"],
	);
	for (const order of ["prune-first", "compaction-first"] as const) {
		const sessionDir = await mkdtemp(join(tmpdir(), `ker-daemon-prune-${order}-`));
		t.after(() => rm(sessionDir, { recursive: true, force: true }));
		const store = new SessionStore({ baseDir: sessionDir });
		const session = await seedInterleavedContext(store, order);
		const captured: Engine.HarnessState[] = [];
		const running = await startServer(t, passiveFactory(captured), { sessionDir });
		await getSnapshot(running.url, session.session.id);

		assert.deepEqual(captured[0]?.messages, liveProjection);
	}
});

test("a log ending on a pruned event replays consistently during recovery", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-prune-recovery-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const session = await store.create(process.cwd());
	await session.log.append([
		{
			type: "conversation",
			id: "entry-tool",
			parentId: null,
			turnId: "turn-old",
			message: { role: "tool", toolCallId: "call-old", content: "large output" },
		},
		{ type: "prune", toolCallIds: ["call-old"], tokensBefore: 30_000, tokensAfter: 30 },
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "pruned",
				toolCallIds: ["call-old"],
				tokensBefore: 30_000,
				tokensAfter: 30,
			},
		},
	]);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), { sessionDir });
	const snapshot = await getSnapshot(running.url, session.session.id);

	assert.equal(snapshot.queue.running, undefined);
	const tool = captured[0]?.messages[0];
	assert.equal(tool?.role, "tool");
	if (tool?.role === "tool") assert.equal(tool.content, PRUNED_OUTPUT_PLACEHOLDER);
	const [catalog] = await new SessionStore({ baseDir: sessionDir }).scanCatalog();
	assert.equal(catalog.idle, false);
});

test("replay projects the latest compaction while preserving every transcript entry", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-compaction-replay-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: sessionDir });
	const session = await store.create(process.cwd());
	const oldUsage: Protocol.Usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 };
	const newUsage: Protocol.Usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 };
	await session.log.append([
		{
			type: "conversation",
			id: "entry-old-user",
			parentId: null,
			turnId: "turn-old",
			message: { role: "user", content: "old user" },
		},
		{
			type: "conversation",
			id: "entry-old-assistant",
			parentId: "entry-old-user",
			turnId: "turn-old",
			message: {
				role: "assistant",
				content: "old assistant",
				provider: "openai",
				model: "gpt-5.4-mini",
				usage: oldUsage,
			},
		},
		{
			type: "conversation",
			id: "entry-kept-user",
			parentId: "entry-old-assistant",
			turnId: "turn-kept",
			message: { role: "user", content: "kept user" },
		},
		{
			type: "conversation",
			id: "entry-kept-assistant",
			parentId: "entry-kept-user",
			turnId: "turn-kept",
			message: {
				role: "assistant",
				content: "kept assistant",
				provider: "openai",
				model: "gpt-5.4-mini",
				usage: oldUsage,
			},
		},
		{
			type: "compaction",
			turnId: "turn-compact",
			summary: "summary",
			firstKeptEntryId: "entry-kept-user",
			tokensBefore: 100,
			tokensAfter: 25,
		},
		{
			type: "conversation",
			id: "entry-new-user",
			parentId: "entry-kept-assistant",
			turnId: "turn-new",
			message: { role: "user", content: "new user" },
		},
		{
			type: "conversation",
			id: "entry-new-assistant",
			parentId: "entry-new-user",
			turnId: "turn-new",
			message: {
				role: "assistant",
				content: "new assistant",
				provider: "openai",
				model: "gpt-5.4-mini",
				usage: newUsage,
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 1, waiting: [] },
			},
		},
	]);
	const captured: Engine.HarnessState[] = [];
	const running = await startServer(t, passiveFactory(captured), { sessionDir });
	const snapshot = await getSnapshot(running.url, session.session.id);

	assert.deepEqual(
		snapshot.entries.map((entry) => entry.role),
		["user", "assistant", "user", "assistant", "compaction", "user", "assistant"],
	);
	const projected = captured[0]?.messages;
	assert.deepEqual(
		projected?.map((message) => message.role),
		["developer", "user", "assistant", "user", "assistant"],
	);
	const keptAssistant = projected?.[2];
	assert.equal(keptAssistant?.role, "assistant");
	if (keptAssistant?.role === "assistant") assert.equal(keptAssistant.usage, undefined);
	const newAssistant = projected?.at(-1);
	assert.equal(newAssistant?.role, "assistant");
	if (newAssistant?.role === "assistant") assert.deepEqual(newAssistant.usage, newUsage);
});

test("a completed turn leaves an empty queue_changed as the final log record", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-final-record-"));
	t.after(() => rm(sessionDir, { recursive: true, force: true }));
	const running = await startServer(t, immediateFactory(), { sessionDir });
	const session = await createSession(running.url);
	const admitted = await prompt(running.url, session.id, "done");
	await waitForTerminal(running.url, session.id, admitted.turnId);

	const [entry] = await new SessionStore({ baseDir: sessionDir }).scanCatalog();
	assert.equal(entry.idle, true);
	const lines = (await readFile(entry.path, "utf8")).trimEnd().split("\n");
	const last = JSON.parse(lines.at(-1) ?? "") as StoredRecord;
	assert.equal(last.type, "event");
	if (last.type === "event") {
		assert.equal(last.event.type, "queue_changed");
		if (last.event.type === "queue_changed") {
			assert.equal(last.event.queue.running, undefined);
			assert.deepEqual(last.event.queue.waiting, []);
		}
	}
});

test("shutdown aborts and awaits active turns in every session", async (t) => {
	const controlled = controlledFactory({ pauseAfterAbort: true });
	const running = await startServer(t, controlled.factory, {}, false);
	const firstSession = await createSession(running.url);
	const secondSession = await createSession(running.url);
	await prompt(running.url, firstSession.id, "A");
	await prompt(running.url, secondSession.id, "B");
	await Promise.all([controlled.deltaSeen(0), controlled.deltaSeen(1)]);

	const closing = running.close();
	controlled.releaseCleanup(0);
	controlled.releaseCleanup(1);
	await closing;
	await Promise.all([controlled.finished(0), controlled.finished(1)]);
});

function compactionFactory(
	requests: Engine.CompactionRequest[],
	outcome: "compacted" | "skipped" | { tokensBefore: number; tokensAfter: number },
): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			async *compact(input) {
				requests.push(structuredClone(input));
				if (outcome === "skipped") return { kind: "skipped", reason: "nothing_to_compact" };
				const usage: Protocol.Usage = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5 };
				const summary = `summary-${requests.length}`;
				yield {
					actor: "process",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "usage",
					provider: "openai",
					model: "gpt-5.4-mini",
					usage,
				};
				const kept = state.messages.slice(-1).map(Engine.stripAssistantUsage);
				const messages = [Engine.compactionSummaryMessage(summary), ...kept];
				return {
					kind: "compacted",
					summary,
					keptCount: kept.length,
					tokensBefore: typeof outcome === "string" ? 17 : outcome.tokensBefore,
					tokensAfter: typeof outcome === "string" ? 5 : outcome.tokensAfter,
					messages,
				};
			},
			async *send(input) {
				const usage: Protocol.Usage = {
					input: 10,
					output: 4,
					cacheRead: 2,
					cacheWrite: 1,
					total: 17,
				};
				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				const messageId = randomUUID();
				const text = `answer:${input.text}`;
				yield delta(input, messageId, text);
				state.messages.push({
					role: "assistant",
					content: text,
					provider: "openai",
					model: "gpt-5.4-mini",
					usage,
				});
				yield completed(input, messageId);
				yield usageEvent(input, "gpt-5.4-mini", usage);
				yield end(input);
			},
		};
	};
}

function immediateFactory(): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			compact: skippedCompaction,
			async *send(input) {
				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				const messageId = randomUUID();
				const text = `answer:${input.text}`;
				yield delta(input, messageId, text);
				state.messages.push({ role: "assistant", content: text, toolCalls: [], reasoning: [] });
				yield completed(input, messageId);
				yield end(input);
			},
		};
	};
}

function accountingFactory(model = "gpt-5.4-mini"): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			compact: skippedCompaction,
			async *send(input) {
				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				if (input.text === "filtered") {
					const usage: Protocol.Usage = {
						input: 8,
						output: 3,
						cacheRead: 1,
						cacheWrite: 1,
						reasoning: 1,
						total: 13,
					};
					yield {
						actor: "process",
						sessionId: input.sessionId,
						turnId: input.turnId,
						type: "usage",
						provider: "openai",
						model,
						usage,
					};
					yield {
						actor: "process",
						sessionId: input.sessionId,
						turnId: input.turnId,
						type: "error",
						message: "The model response was stopped by a content filter",
					};
					yield end(input);
					return;
				}
				const messageId = randomUUID();
				const text = `answer:${input.text}`;
				const usage: Protocol.Usage = {
					input: 10,
					output: 4,
					cacheRead: 2,
					cacheWrite: 1,
					reasoning: 2,
					total: 17,
				};
				yield delta(input, messageId, text);
				state.messages.push({
					role: "assistant",
					content: text,
					toolCalls: [],
					reasoning: [],
					provider: "openai",
					model,
					usage,
				});
				yield completed(input, messageId);
				yield {
					actor: "process",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "usage",
					provider: "openai",
					model,
					usage,
				};
				yield end(input);
			},
		};
	};
}

function multiStepAccountingFactory(): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			compact: skippedCompaction,
			async *send(input) {
				const model = "gpt-5.4-mini";
				const firstMessageId = randomUUID();
				const firstUsage: Protocol.Usage = {
					input: 1,
					output: 2,
					cacheRead: 3,
					cacheWrite: 4,
					reasoning: 1,
					total: 10,
				};
				const secondMessageId = randomUUID();
				const secondUsage: Protocol.Usage = {
					input: 11,
					output: 12,
					cacheRead: 13,
					cacheWrite: 14,
					reasoning: 5,
					total: 50,
				};

				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				yield {
					actor: "agent",
					modelRole: "assistant",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "tool_call",
					messageId: firstMessageId,
					id: "call-1",
					name: "calculate",
					arguments: "{}",
				};
				state.messages.push({
					role: "assistant",
					content: "",
					toolCalls: [{ callId: "call-1", name: "calculate", arguments: "{}" }],
					reasoning: [],
					provider: "openai",
					model,
					usage: firstUsage,
				});
				yield completed(input, firstMessageId);
				yield usageEvent(input, model, firstUsage);
				state.messages.push({ role: "tool", toolCallId: "call-1", content: "42" });
				yield {
					actor: "process",
					modelRole: "tool",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "tool_result",
					id: "call-1",
					name: "calculate",
					status: "ok",
					output: "42",
				};
				yield delta(input, secondMessageId, "42");
				state.messages.push({
					role: "assistant",
					content: "42",
					toolCalls: [],
					reasoning: [],
					provider: "openai",
					model,
					usage: secondUsage,
				});
				yield completed(input, secondMessageId);
				yield usageEvent(input, model, secondUsage);
				yield end(input);
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
			compact: skippedCompaction,
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
	const session = await store.create(process.cwd());
	const item: Protocol.PromptQueueItem = {
		id: "queue-1",
		turnId: "turn-1",
		kind: "prompt",
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

async function seedRunningCompaction(store: SessionStore, compacted: boolean) {
	const session = await store.create(process.cwd());
	const item: Protocol.CompactionQueueItem = {
		id: "queue-compact",
		turnId: "turn-compact",
		kind: "compaction",
		source: "auto",
		state: "running",
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
	const payloads: Payload[] = [
		{
			type: "conversation",
			id: "entry-kept",
			parentId: null,
			turnId: "turn-old",
			message: { role: "user", content: "kept context" },
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				turnId: item.turnId,
				type: "compaction_submitted",
				queueItemId: item.id,
				source: item.source,
				admission: "running",
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 1, running: item, waiting: [] },
			},
		},
	];
	if (compacted) {
		payloads.push(
			{
				type: "compaction",
				turnId: item.turnId,
				summary: "recovered summary",
				firstKeptEntryId: "entry-kept",
				tokensBefore: 100,
				tokensAfter: 20,
			},
			{
				type: "event",
				event: {
					actor: "process",
					sessionId: session.session.id,
					turnId: item.turnId,
					type: "compacted",
					summary: "recovered summary",
					tokensBefore: 100,
					tokensAfter: 20,
					firstKeptEntryId: "entry-kept",
				},
			},
		);
	}
	await session.log.append(payloads);
	return { session, item };
}

async function seedPrunableSession(store: SessionStore) {
	const session = await store.create(process.cwd());
	const messages = ["a", "b", "c", "previous", "current"].flatMap(prunableToolTurn);
	const payloads: Payload[] = messages.map((message, index) => ({
		type: "conversation",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		turnId: `turn-${Math.floor(index / 3)}`,
		message,
	}));
	payloads.push(
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				turnId: "turn-current",
				type: "usage",
				provider: "openai",
				model: "gpt-5.4-mini",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 1, waiting: [] },
			},
		},
	);
	await session.log.append(payloads);
	return { session, messages };
}

function prunableToolTurn(id: string): Engine.HarnessState["messages"] {
	const content = id.repeat(Math.ceil(120_000 / id.length)).slice(0, 120_000);
	return [
		{ role: "user", content: `request ${id}` },
		{
			role: "assistant",
			content: "",
			toolCalls: [{ callId: `call-${id}`, name: "read", arguments: "{}" }],
		},
		{ role: "tool", toolCallId: `call-${id}`, content },
	];
}

async function seedInterleavedContext(store: SessionStore, order: "prune-first" | "compaction-first") {
	const session = await store.create(process.cwd());
	const prune: Payload = {
		type: "prune",
		toolCallIds: ["call-old"],
		tokensBefore: 30_000,
		tokensAfter: 30,
	};
	const compaction: Payload = {
		type: "compaction",
		turnId: "turn-compact",
		summary: "summary",
		firstKeptEntryId: "entry-owner",
		tokensBefore: 30_000,
		tokensAfter: 30,
	};
	const mutations = order === "prune-first" ? [prune, compaction] : [compaction, prune];
	await session.log.append([
		{
			type: "conversation",
			id: "entry-owner",
			parentId: null,
			turnId: "turn-old",
			message: {
				role: "assistant",
				content: "",
				toolCalls: [{ callId: "call-old", name: "read", arguments: "{}" }],
			},
		},
		{
			type: "conversation",
			id: "entry-tool",
			parentId: "entry-owner",
			turnId: "turn-old",
			message: { role: "tool", toolCallId: "call-old", content: "large output" },
		},
		...mutations,
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 1, waiting: [] },
			},
		},
	]);
	return session;
}

async function seedCancellingWithWaiting(store: SessionStore) {
	const session = await seedRunning(store, [], "cancelling");
	const running: Protocol.PromptQueueItem = {
		id: "queue-1",
		turnId: "turn-1",
		kind: "prompt",
		messageId: "message-1",
		text: "hello",
		state: "cancelling",
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
	const waiting: Protocol.PromptQueueItem = {
		id: "queue-2",
		turnId: "turn-2",
		kind: "prompt",
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

async function seedWaitingCompaction(store: SessionStore) {
	const session = await store.create(process.cwd());
	const item: Protocol.CompactionQueueItem = {
		id: "queue-compact",
		turnId: "turn-compact",
		kind: "compaction",
		source: "manual",
		state: "waiting",
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
	await session.log.append([
		{
			type: "event",
			event: {
				actor: "human",
				sessionId: session.session.id,
				turnId: item.turnId,
				type: "compaction_submitted",
				queueItemId: item.id,
				source: item.source,
				admission: "waiting",
			},
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 1, waiting: [item] },
			},
		},
	]);
	return { session, item };
}

async function seedWaiting(store: SessionStore, items: Array<{ text: string; submittedAt: string }>) {
	const session = await store.create(process.cwd());
	const waiting: Protocol.PromptQueueItem[] = items.map((item, index) => ({
		id: `queue-${index + 1}`,
		turnId: `turn-${index + 1}`,
		kind: "prompt",
		messageId: `message-${index + 1}`,
		text: item.text,
		state: "waiting",
		submittedAt: item.submittedAt,
	}));
	const payloads: Payload[] = waiting.map((item) => ({
		type: "event",
		event: {
			actor: "human",
			sessionId: session.session.id,
			turnId: item.turnId,
			type: "message_submitted",
			messageId: item.messageId,
			queueItemId: item.id,
			text: item.text,
			admission: "waiting",
		},
	}));
	payloads.push({
		type: "event",
		event: { actor: "process", sessionId: session.session.id, type: "queue_changed", queue: { revision: 1, waiting } },
	});
	await session.log.append(payloads);
	return { session, waiting };
}

function controlledFactory(options: { pauseAfterDelta?: boolean; pauseAfterAbort?: boolean } = {}): {
	factory: NonNullable<DaemonOptions["harnessFactory"]>;
	initials: string[];
	started(index: number): Promise<void>;
	deltaSeen(index: number): Promise<void>;
	finished(index: number): Promise<void>;
	release(index: number): void;
	releaseCleanup(index: number): void;
} {
	const initials: string[] = [];
	const starts: PromiseWithResolvers<void>[] = [];
	const deltas: PromiseWithResolvers<void>[] = [];
	const finishes: PromiseWithResolvers<void>[] = [];
	const releases: PromiseWithResolvers<void>[] = [];
	const cleanupReleases: PromiseWithResolvers<void>[] = [];
	const factory = (initial: Engine.HarnessState): Harness => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			compact: skippedCompaction,
			async *send(input, signal) {
				const index = initials.length;
				initials.push(input.text);
				starts[index] ??= Promise.withResolvers<void>();
				deltas[index] ??= Promise.withResolvers<void>();
				finishes[index] ??= Promise.withResolvers<void>();
				releases[index] ??= Promise.withResolvers<void>();
				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				starts[index].resolve();
				const messageId = randomUUID();
				const text = `answer:${input.text}`;
				yield delta(input, messageId, text);
				deltas[index].resolve();
				if (options.pauseAfterDelta) await releases[index].promise;
				if (!options.pauseAfterDelta) await Promise.race([releases[index].promise, waitForAbort(signal)]);
				if (signal?.aborted) {
					cleanupReleases[index] ??= Promise.withResolvers<void>();
					if (options.pauseAfterAbort) await cleanupReleases[index].promise;
					yield { actor: "process", sessionId: input.sessionId, turnId: input.turnId, type: "aborted" };
					finishes[index].resolve();
					yield end(input);
					return;
				}
				state.messages.push({ role: "assistant", content: text, toolCalls: [], reasoning: [] });
				yield completed(input, messageId);
				finishes[index].resolve();
				yield end(input);
			},
		};
	};
	return {
		factory,
		initials,
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

function usageEvent(message: Engine.UserMessage, model: string, usage: Protocol.Usage): Protocol.UsageEvent {
	return {
		actor: "process",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "usage",
		provider: "openai",
		model,
		usage,
	};
}

function end(message: Engine.UserMessage): Protocol.EndEvent {
	return { actor: "process", sessionId: message.sessionId, turnId: message.turnId, type: "end" };
}

async function* skippedCompaction(): AsyncGenerator<Protocol.TurnEvent, Engine.CompactionOutcome> {
	yield* [];
	return { kind: "skipped", reason: "nothing_to_compact" };
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
		sessionDir,
		harnessFactory,
		eventTailSize: options.eventTailSize,
		recoveryWindowMinutes: options.recoveryWindowMinutes ?? Number.MAX_SAFE_INTEGER,
		compaction: options.compaction ?? {
			enabled: true,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
			prune: true,
		},
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

async function createSession(url: string, cwd = process.cwd()): Promise<Protocol.SessionDescriptor> {
	const request: Protocol.CreateSessionRequest = { cwd };
	const response = await localFetch(`${url}/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
	assert.equal(response.status, 201);
	return readJson(response.body);
}

async function getSnapshot(url: string, sessionId: string): Promise<Protocol.SessionSnapshot> {
	const response = await localFetch(`${url}/sessions/${sessionId}`);
	assert.equal(response.status, 200);
	return readJson(response.body);
}

async function prompt(url: string, sessionId: string, text: string): Promise<Protocol.PromptAdmission> {
	const response = await rawPrompt(url, sessionId, { text });
	assert.equal(response.status, 202);
	return readJson(response.body);
}

function rawPrompt(url: string, sessionId: string, body: object): Promise<TestResponse> {
	return localFetch(`${url}/sessions/${sessionId}/prompts`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function rawCompact(url: string, sessionId: string, body: object): Promise<TestResponse> {
	return localFetch(`${url}/sessions/${sessionId}/compact`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
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

async function waitForCompaction(url: string, sessionId: string, promptTurnId: string): Promise<void> {
	while (true) {
		const snapshot = await getSnapshot(url, sessionId);
		const compacted = snapshot.entries.some((entry) => entry.role === "compaction");
		if (compacted && !snapshot.queue.running && snapshot.queue.waiting.length === 0) return;
		const compactionTurn = snapshot.turns.find((turn) => turn.id !== promptTurnId);
		if (
			compactionTurn &&
			compactionTurn.status !== "running" &&
			compactionTurn.status !== "cancelling" &&
			compactionTurn.status !== "waiting"
		) {
			throw new Error(`Automatic compaction ended with status ${compactionTurn.status}`);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function waitForCompactionAttempts(
	url: string,
	sessionId: string,
	requests: readonly Engine.CompactionRequest[],
	count: number,
): Promise<void> {
	while (true) {
		const snapshot = await getSnapshot(url, sessionId);
		if (requests.length >= count && !snapshot.queue.running && snapshot.queue.waiting.length === 0) return;
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
