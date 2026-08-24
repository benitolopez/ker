import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { drizzle } from "drizzle-orm/node-sqlite";
import { Catalog, defaultCatalogPath } from "../src/catalog.ts";
import { CATALOG_VERSION, DDL, session } from "../src/schema.ts";
import type { CatalogedSession } from "../src/store.ts";

test("creates a private versioned database and preserves rows on reopen", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-open-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "nested", "catalog.db");
	const catalog = Catalog.open(path);
	const descriptor = sessionDescriptor("session-1", "/project/one", "/project/one");
	catalog.upsertCreated(descriptor);
	catalog.close();

	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const client = new DatabaseSync(path);
	assert.equal((client.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CATALOG_VERSION);
	client.close();

	const reopened = Catalog.open(path);
	assert.equal(reopened.get(descriptor.id)?.cwd, descriptor.cwd);
	reopened.close();
});

test("recreates a catalog whose version does not match", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-version-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const catalog = Catalog.open(path);
	catalog.upsertCreated(sessionDescriptor("session-old", "/old", "/old"));
	catalog.close();

	const outdated = new DatabaseSync(path);
	outdated.exec("PRAGMA user_version = 99");
	outdated.close();
	const recreated = Catalog.open(path);
	assert.equal(recreated.get("session-old"), undefined);
	recreated.close();

	const client = new DatabaseSync(path);
	assert.equal((client.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CATALOG_VERSION);
	client.close();
});

test("recreates a corrupt catalog", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-corrupt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	await writeFile(path, "not a sqlite database");

	const catalog = Catalog.open(path);
	const descriptor = sessionDescriptor("session-recovered", "/project", "/project");
	catalog.upsertCreated(descriptor);
	assert.equal(catalog.get(descriptor.id)?.cwd, descriptor.cwd);
	catalog.close();

	const client = new DatabaseSync(path);
	assert.equal((client.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CATALOG_VERSION);
	client.close();
});

test("does not replace a catalog after an unrelated open error", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-open-error-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	assert.throws(() => Catalog.open(root), /unable to open database file/);
	assert.equal((await stat(root)).isDirectory(), true);
});

test("the DDL round-trips every schema column through Drizzle", () => {
	const client = new DatabaseSync(":memory:");
	client.exec(DDL);
	const db = drizzle({ client });
	const expected = {
		id: "session-1",
		project_key: "project-key",
		project_root: "/project",
		cwd: "/project/nested",
		title: "First prompt",
		status: "busy" as const,
		error: "failure",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
	};
	db.insert(session).values(expected).run();
	assert.deepEqual(db.select().from(session).get(), expected);
	client.close();
});

test("reconcile refreshes derived fields, preserves metadata, and removes vanished rows", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-reconcile-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const catalog = Catalog.open(join(root, "catalog.db"));
	t.after(() => catalog.close());
	const first = catalogedSession("session-1", "/project", "/project/one", true);
	const second = catalogedSession("session-2", "/project", "/project/two", false);
	catalog.reconcile({ sessions: [first, second], unreadable: [] });
	catalog.setTitleIfEmpty(first.session.id, "Saved title");

	const updatedFirst = {
		...first,
		idle: false,
		session: { ...first.session, updatedAt: "2026-02-01T00:00:00.000Z" },
	};
	catalog.reconcile({
		sessions: [updatedFirst],
		unreadable: [{ id: second.session.id, projectKey: second.projectKey, error: "broken tail" }],
	});
	assert.deepEqual(catalog.get(first.session.id), {
		id: first.session.id,
		project_key: first.projectKey,
		project_root: "/project",
		cwd: "/project/one",
		title: "Saved title",
		status: "busy",
		error: null,
		created_at: first.session.createdAt,
		updated_at: updatedFirst.session.updatedAt,
	});
	assert.deepEqual(catalog.get(second.session.id), {
		id: second.session.id,
		project_key: second.projectKey,
		project_root: "/project",
		cwd: "/project/two",
		title: null,
		status: "unreadable",
		error: "broken tail",
		created_at: second.session.createdAt,
		updated_at: second.session.updatedAt,
	});

	catalog.reconcile({
		sessions: [],
		unreadable: [{ id: "never-readable", projectKey: "unknown-project", error: "bad header" }],
	});
	assert.equal(catalog.get(first.session.id), undefined);
	assert.equal(catalog.get(second.session.id), undefined);
	assert.deepEqual(catalog.get("never-readable"), {
		id: "never-readable",
		project_key: "unknown-project",
		project_root: null,
		cwd: null,
		title: null,
		status: "unreadable",
		error: "bad header",
		created_at: null,
		updated_at: null,
	});
});

test("title, touch, unreadable state, ordering, and list scope follow catalog rules", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-queries-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const catalog = Catalog.open(join(root, "catalog.db"));
	t.after(() => catalog.close());
	const projectA = "project-a";
	const first = catalogedSession("session-1", "/project-a", "/project-a/one", true, projectA);
	const second = catalogedSession("session-2", "/project-a", "/project-a/two", true, projectA);
	const third = catalogedSession("session-3", "/project-b", "/project-b", true, "project-b");
	second.session.createdAt = "2026-01-02T00:00:00.000Z";
	second.session.updatedAt = second.session.createdAt;
	third.session.createdAt = "2026-01-03T00:00:00.000Z";
	third.session.updatedAt = third.session.createdAt;
	catalog.reconcile({ sessions: [third, second, first], unreadable: [] });
	catalog.setTitleIfEmpty(first.session.id, "Original");
	catalog.setTitleIfEmpty(first.session.id, "Replacement");
	catalog.touch(first.session.id, { updatedAt: "2026-03-01T00:00:00.000Z", status: "busy" });
	catalog.markUnreadable(second.session.id, "load failed");

	assert.equal(catalog.get(first.session.id)?.title, "Original");
	assert.deepEqual(
		catalog.list().map((row) => row.id),
		[first.session.id, second.session.id, third.session.id],
	);
	assert.deepEqual(
		catalog.list({ cwd: first.session.cwd, projectKey: projectA }).map((row) => row.id),
		[first.session.id, second.session.id],
	);
	assert.equal(catalog.get(first.session.id)?.status, "busy");
	assert.equal(catalog.get(first.session.id)?.updated_at, "2026-03-01T00:00:00.000Z");
	assert.equal(catalog.get(second.session.id)?.error, "load failed");
});

test("uses KER_CATALOG_PATH before the user-owned default", (t) => {
	const previous = process.env.KER_CATALOG_PATH;
	delete process.env.KER_CATALOG_PATH;
	t.after(() => {
		if (previous === undefined) delete process.env.KER_CATALOG_PATH;
		if (previous !== undefined) process.env.KER_CATALOG_PATH = previous;
	});

	assert.equal(defaultCatalogPath(), join(homedir(), ".ker", "catalog.db"));
	process.env.KER_CATALOG_PATH = join(tmpdir(), "ker-custom-catalog.db");
	assert.equal(defaultCatalogPath(), join(tmpdir(), "ker-custom-catalog.db"));
});

function sessionDescriptor(id: string, projectRoot: string, cwd: string): Protocol.SessionDescriptor {
	return {
		id,
		projectRoot,
		cwd,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function catalogedSession(
	id: string,
	projectRoot: string,
	cwd: string,
	idle: boolean,
	projectKey = "project-key",
): CatalogedSession {
	return {
		session: sessionDescriptor(id, projectRoot, cwd),
		path: join("/sessions", projectKey, id, "session.jsonl"),
		projectKey,
		idle,
	};
}
