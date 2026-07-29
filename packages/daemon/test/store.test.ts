import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
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
	assert.equal(session.records[0].version, 3);
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

	const [entry] = await store.scanCatalog();
	const loaded = await store.loadSession(entry.path);
	assert.equal(loaded.records.length, 3);
});

test("round-trips prune records", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-prune-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	await session.log.append([
		{
			type: "prune",
			toolCallIds: ["call-1", "call-2"],
			tokensBefore: 120_000,
			tokensAfter: 60_000,
		},
	]);

	const loaded = await store.loadSession(session.log.path);
	const prune = loaded.records.find((record) => record.type === "prune");
	assert(prune);
	assert.deepEqual(prune.toolCallIds, ["call-1", "call-2"]);
	assert.equal(prune.tokensBefore, 120_000);
	assert.equal(prune.tokensAfter, 60_000);
});

test("truncates only a malformed final partial line", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-torn-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	const completeSize = (await stat(session.log.path)).size;
	await appendFile(session.log.path, '{"version":3,"id":"torn"');
	const tornSize = (await stat(session.log.path)).size;

	const [entry] = await store.scanCatalog();
	assert.equal(entry.idle, false);
	assert.equal((await stat(session.log.path)).size, tornSize);
	await store.loadSession(entry.path);
	assert.equal((await stat(session.log.path)).size, completeSize);
});

test("keeps v2 sessions unreadable without changing their bytes", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-v2-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	const v2 = `${JSON.stringify({
		version: 2,
		recordId: "record-1",
		previousRecordId: null,
		at: "2026-01-01T00:00:00.000Z",
		type: "session",
		session: session.session,
	})}\n`;
	await writeFile(session.log.path, v2);

	assert.deepEqual(await store.scanCatalog(), []);
	assert.equal(store.listUnreadable()[0]?.id, session.session.id);
	assert.equal(await readFile(session.log.path, "utf8"), v2);
});

test("rejects a malformed complete tail at load without repairing it", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-complete-tail-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	await appendFile(session.log.path, '{"version":3,}');
	const before = await readFile(session.log.path);

	const [entry] = await store.scanCatalog();
	assert.equal(entry.session.id, session.session.id);
	assert.equal(entry.idle, false);
	await assert.rejects(store.loadSession(entry.path));
	assert.deepEqual(await readFile(session.log.path), before);
});

test("repairs a valid final record that is missing its newline", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-newline-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	const contents = await readFile(session.log.path, "utf8");
	await writeFile(session.log.path, contents.trimEnd());

	const [entry] = await store.scanCatalog();
	assert.equal(entry.idle, false);
	const loaded = await store.loadSession(entry.path);
	await loaded.log.append([{ type: "identity", identity: { kind: "apikey" } }]);
	const lines = (await readFile(session.log.path, "utf8")).trimEnd().split("\n");
	assert.equal(lines.length, 2);
});

test("admits deep corruption at scan and rejects it at load", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-malformed-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const malformed = await store.create(baseDir);
	const healthy = await store.create(baseDir);
	const original = await readFile(malformed.log.path, "utf8");
	await writeFile(malformed.log.path, `${original}not-json\n{"also":"bad"}`);

	const catalog = await store.scanCatalog();
	assert.deepEqual(
		new Set(catalog.map((entry) => entry.session.id)),
		new Set([malformed.session.id, healthy.session.id]),
	);
	assert.deepEqual(store.listUnreadable(), []);
	const malformedEntry = catalog.find((entry) => entry.session.id === malformed.session.id);
	await assert.rejects(store.loadSession(malformedEntry?.path ?? ""), /Unexpected token|Malformed record/);
	const healthyEntry = catalog.find((entry) => entry.session.id === healthy.session.id);
	const loaded = await store.loadSession(healthyEntry?.path ?? "");
	assert.equal(loaded.session.id, healthy.session.id);
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

	const catalog = await new SessionStore({ baseDir }).scanCatalog();
	const loadedById = new Map(catalog.map((entry) => [entry.session.id, entry.session]));
	assert.deepEqual(
		{ cwd: loadedById.get(first.session.id)?.cwd, projectRoot: loadedById.get(first.session.id)?.projectRoot },
		{ cwd: canonicalCwdA, projectRoot: canonicalProjectA },
	);
	assert.deepEqual(
		{ cwd: loadedById.get(second.session.id)?.cwd, projectRoot: loadedById.get(second.session.id)?.projectRoot },
		{ cwd: canonicalProjectB, projectRoot: canonicalProjectB },
	);
});

test("catalog freshness comes from file mtime until a session is loaded", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-mtime-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	const touched = new Date("2026-02-03T04:05:06Z");
	await utimes(session.log.path, touched, touched);

	const [entry] = await store.scanCatalog();
	assert.equal(entry.session.id, session.session.id);
	assert.equal(entry.session.updatedAt, touched.toISOString());
	assert.equal(entry.path, session.log.path);
	assert.equal(entry.idle, true);

	const loaded = await store.loadSession(entry.path);
	assert.equal(loaded.session.updatedAt, loaded.records.at(-1)?.at);
});

test("flags a session with an unreadable header line", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-header-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	await writeFile(session.log.path, "not-json\n");

	assert.deepEqual(await store.scanCatalog(), []);
	assert.equal(store.listUnreadable()[0]?.id, session.session.id);
	assert.equal(store.listUnreadable(session.session.projectRoot)[0]?.id, session.session.id);
	assert.deepEqual(store.listUnreadable(join(session.session.projectRoot, "elsewhere")), []);
});

test("classifies idle sessions from the final complete record", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-idle-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const idle = await store.create(baseDir);
	await idle.log.append([
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: idle.session.id,
				type: "queue_changed",
				queue: { revision: 2, waiting: [] },
			},
		},
	]);
	const busy = await store.create(baseDir);
	await busy.log.append([
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: busy.session.id,
				type: "queue_changed",
				queue: {
					revision: 1,
					running: {
						id: "queue-1",
						turnId: "turn-1",
						kind: "prompt",
						messageId: "message-1",
						text: "hello",
						state: "running",
						submittedAt: "2026-01-01T00:00:00.000Z",
					},
					waiting: [],
				},
			},
		},
	]);
	const midTurn = await store.create(baseDir);
	await midTurn.log.append([{ type: "identity", identity: { kind: "apikey" } }]);
	const torn = await store.create(baseDir);
	await appendFile(torn.log.path, '{"version":3');
	const bare = await store.create(baseDir);

	const idleById = new Map((await store.scanCatalog()).map((entry) => [entry.session.id, entry.idle]));
	assert.equal(idleById.get(idle.session.id), true);
	assert.equal(idleById.get(bare.session.id), true);
	assert.equal(idleById.get(busy.session.id), false);
	assert.equal(idleById.get(midTurn.session.id), false);
	assert.equal(idleById.get(torn.session.id), false);
});

test("round-trips compaction records and classifies their completed queue as idle", async (t) => {
	const baseDir = await mkdtemp(join(tmpdir(), "ker-store-compaction-"));
	t.after(() => rm(baseDir, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir });
	const session = await store.create(baseDir);
	await session.log.append([
		{
			type: "conversation",
			id: "entry-1",
			parentId: null,
			turnId: "turn-1",
			message: { role: "user", content: "hello" },
		},
		{
			type: "compaction",
			turnId: "turn-compact",
			summary: "summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 100,
			tokensAfter: 20,
		},
		{
			type: "event",
			event: {
				actor: "process",
				sessionId: session.session.id,
				type: "queue_changed",
				queue: { revision: 2, waiting: [] },
			},
		},
	]);

	const [catalog] = await store.scanCatalog();
	assert.equal(catalog.idle, true);
	const loaded = await store.loadSession(catalog.path);
	const compacted = loaded.records.find((record) => record.type === "compaction");
	assert.equal(compacted?.type, "compaction");
	if (compacted?.type === "compaction") {
		assert.equal(compacted.firstKeptEntryId, "entry-1");
		assert.equal(compacted.summary, "summary");
	}
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
