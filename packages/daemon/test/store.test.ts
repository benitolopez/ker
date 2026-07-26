import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSessionDir, SessionStore } from "../src/store.ts";

test("writes chained versioned records and keeps conversation ancestry explicit", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
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
	assert.equal(session.records[0].version, 2);
});

test("serializes concurrent appends within one session", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-serialized-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
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
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	const completeSize = (await stat(session.log.path)).size;
	await appendFile(session.log.path, '{"version":2,"id":"torn"');

	const loaded = await store.loadAll();
	assert.equal(loaded.length, 1);
	assert.equal((await stat(session.log.path)).size, completeSize);
});

test("keeps v1 sessions unreadable without changing their bytes", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-v1-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	const v1 = `${JSON.stringify({
		version: 1,
		recordId: "record-1",
		previousRecordId: null,
		at: "2026-01-01T00:00:00.000Z",
		type: "session",
		session: session.session,
	})}\n`;
	await writeFile(session.log.path, v1);

	assert.deepEqual(await store.loadAll(), []);
	assert.equal(store.listUnreadable()[0]?.id, session.session.id);
	assert.equal(await readFile(session.log.path, "utf8"), v1);
});

test("keeps a malformed complete tail without repairing it", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-complete-tail-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	await appendFile(session.log.path, '{"version":2,}');
	const before = await readFile(session.log.path);

	assert.deepEqual(await store.loadAll(), []);
	assert.deepEqual(await readFile(session.log.path), before);
});

test("repairs a valid final record that is missing its newline", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-newline-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
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
	const store = new SessionStore({ baseDir });
	const malformed = await store.create(baseDir);
	const healthy = await store.create(baseDir);
	const original = await readFile(malformed.log.path, "utf8");
	await writeFile(malformed.log.path, `${original}not-json\n{"also":"bad"}`);

	const loaded = await store.loadAll();
	assert.deepEqual(
		loaded.map((session) => session.session.id),
		[healthy.session.id],
	);
	assert.equal(store.listUnreadable().length, 1);
	assert.equal(store.listUnreadable()[0]?.id, malformed.session.id);
	assert.match(store.listUnreadable()[0]?.error ?? "", /Unexpected token|Malformed record/);
});

test("persists provider identity without credentials", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-identity-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	await session.log.append([{ type: "identity", identity: { kind: "oauth", accountId: "account-1" } }]);

	const contents = await readFile(session.log.path, "utf8");
	assert.match(contents, /account-1/);
	assert.doesNotMatch(contents, /accessToken|apiKey|secret-token|sk-/);
});

test("creates and reloads sessions from every project bucket", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-store-projects-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const baseDir = join(root, "sessions");
	const projectA = join(root, "project-a");
	const cwdA = join(projectA, "nested");
	const projectB = join(root, "project-b");
	await Promise.all([
		mkdir(join(projectA, ".git"), { recursive: true }),
		mkdir(cwdA, { recursive: true }),
		mkdir(projectB, { recursive: true }),
	]);
	const store = new SessionStore({ baseDir });
	const first = await store.create(cwdA);
	const second = await store.create(projectB);
	const canonicalRoot = await realpath(root);
	const canonicalProjectA = join(canonicalRoot, "project-a");
	const canonicalCwdA = join(canonicalProjectA, "nested");
	const canonicalProjectB = join(canonicalRoot, "project-b");

	assert.equal(first.session.cwd, canonicalCwdA);
	assert.equal(first.session.projectRoot, canonicalProjectA);
	assert.equal(second.session.cwd, canonicalProjectB);
	assert.equal(second.session.projectRoot, canonicalProjectB);
	assert.equal(
		first.log.path,
		join(baseDir, createHash("sha256").update(canonicalProjectA).digest("hex"), first.session.id, "session.jsonl"),
	);

	const loaded = await new SessionStore({ baseDir }).loadAll();
	const loadedById = new Map(loaded.map((session) => [session.session.id, session.session]));
	assert.deepEqual(
		{ cwd: loadedById.get(first.session.id)?.cwd, projectRoot: loadedById.get(first.session.id)?.projectRoot },
		{ cwd: canonicalCwdA, projectRoot: canonicalProjectA },
	);
	assert.deepEqual(
		{ cwd: loadedById.get(second.session.id)?.cwd, projectRoot: loadedById.get(second.session.id)?.projectRoot },
		{ cwd: canonicalProjectB, projectRoot: canonicalProjectB },
	);
});

test("uses KER_SESSION_DIR before the user-owned default", (t) => {
	const previous = process.env.KER_SESSION_DIR;
	delete process.env.KER_SESSION_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.KER_SESSION_DIR;
		if (previous !== undefined) process.env.KER_SESSION_DIR = previous;
	});

	assert.equal(defaultSessionDir(), join(homedir(), ".ker", "sessions"));
	process.env.KER_SESSION_DIR = join(tmpdir(), "ker-custom-sessions");
	assert.equal(defaultSessionDir(), join(tmpdir(), "ker-custom-sessions"));
});
