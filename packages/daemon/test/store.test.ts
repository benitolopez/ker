import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/store.ts";

test("writes chained versioned records and keeps conversation ancestry explicit", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir, projectRoot: "/project" });
	const session = await store.create("/project/work");
	const [submitted] = await session.log.append([
		{
			type: "event",
			event: {
				actor: "human",
				sessionId: session.session.id,
				turnId: "turn-1",
				type: "message_submitted",
				messageId: "message-1",
				queueItemId: "queue-1",
				text: "hello",
				placement: "end",
				admission: "running",
			},
		},
	]);
	const [delivered] = await session.log.append([
		{
			type: "conversation",
			id: "entry-1",
			parentId: null,
			turnId: "turn-1",
			messageId: "message-1",
			message: { role: "user", content: "hello" },
		},
	]);

	assert.equal(submitted.previousRecordId, session.records[0].recordId);
	assert.equal(delivered.previousRecordId, submitted.recordId);
	assert.equal(delivered.type, "conversation");
	if (delivered.type === "conversation") assert.equal(delivered.parentId, null);
	assert.equal(session.records[0].version, 1);
});

test("serializes concurrent appends within one session", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-serialized-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir, projectRoot: "/project" });
	const session = await store.create("/project");
	await Promise.all([
		session.log.append([{ type: "identity", identity: { kind: "apikey" } }]),
		session.log.append([{ type: "identity", identity: { kind: "oauth", accountId: "account-1" } }]),
	]);

	const [loaded] = await store.loadAll();
	assert.equal(loaded.records.length, 3);
});

test("truncates only a malformed final partial line", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-torn-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir, projectRoot: "/project" });
	const session = await store.create("/project");
	const completeSize = (await stat(session.log.path)).size;
	await appendFile(session.log.path, '{"version":1,"id":"torn"');

	const loaded = await store.loadAll();
	assert.equal(loaded.length, 1);
	assert.equal((await stat(session.log.path)).size, completeSize);
});

test("repairs a valid final record that is missing its newline", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-newline-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir, projectRoot: "/project" });
	const session = await store.create("/project");
	const contents = await readFile(session.log.path, "utf8");
	await writeFile(session.log.path, contents.trimEnd());

	const [loaded] = await store.loadAll();
	await loaded.log.append([{ type: "identity", identity: { kind: "apikey" } }]);
	const lines = (await readFile(session.log.path, "utf8")).trimEnd().split("\n");
	assert.equal(lines.length, 2);
});

test("isolates a session with a malformed complete record before the final line", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-malformed-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir, projectRoot: "/project" });
	const malformed = await store.create("/project");
	const healthy = await store.create("/project");
	const original = await readFile(malformed.log.path, "utf8");
	await writeFile(malformed.log.path, `${original}not-json\n{"also":"bad"}`);

	const loaded = await store.loadAll();
	assert.deepEqual(
		loaded.map((session) => session.session.id),
		[healthy.session.id],
	);
	assert.equal(store.unreadableSessions.length, 1);
	assert.equal(store.unreadableSessions[0]?.id, malformed.session.id);
	assert.match(store.unreadableSessions[0]?.error ?? "", /Unexpected token|Malformed record/);
});

test("persists provider identity without credentials", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-identity-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir, projectRoot: "/project" });
	const session = await store.create("/project");
	await session.log.append([{ type: "identity", identity: { kind: "oauth", accountId: "account-1" } }]);

	const contents = await readFile(session.log.path, "utf8");
	assert.match(contents, /account-1/);
	assert.doesNotMatch(contents, /accessToken|apiKey|secret-token|sk-/);
});
