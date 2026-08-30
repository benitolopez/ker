import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { drizzle } from "drizzle-orm/node-sqlite";
import { Catalog, defaultCatalogPath } from "../src/catalog.ts";
import type { NodeIdentity } from "../src/node.ts";
import { CATALOG_VERSION, DDL, node, project, session, workspace } from "../src/schema.ts";
import { type CatalogedSession, projectKey } from "../src/store.ts";

const IDENTITY: NodeIdentity = {
	id: "node-1",
	name: "test-node",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const V1_DDL = `
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	project_key TEXT NOT NULL,
	project_root TEXT,
	cwd TEXT,
	title TEXT,
	status TEXT NOT NULL,
	error TEXT,
	created_at TEXT,
	updated_at TEXT
) STRICT;
`;

test("creates a private versioned database and preserves rows on reopen", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-open-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "nested", "catalog.db");
	const catalog = Catalog.open(path);
	catalog.upsertNode(IDENTITY);
	const binding = catalog.createWorkspace({
		nodeId: IDENTITY.id,
		rootPath: "/project/one",
		projectName: "one",
		gitRemote: null,
	});
	const descriptor = sessionDescriptor("session-1", "/project/one", "/project/one");
	catalog.upsertCreated(descriptor, binding);
	catalog.close();

	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const client = new DatabaseSync(path);
	assert.equal((client.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CATALOG_VERSION);
	client.close();

	const reopened = Catalog.open(path);
	assert.equal(reopened.get(descriptor.id)?.cwd, descriptor.cwd);
	reopened.close();
});

test("migrates a v1 catalog in place with titles intact", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-migrate-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	createV1Catalog(path);

	const catalog = Catalog.open(path);
	catalog.close();

	const client = new DatabaseSync(path);
	assert.equal((client.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
	assert.equal(
		(client.prepare("SELECT title FROM session WHERE id = ?").get("session-old") as { title: string }).title,
		"Saved title",
	);
	assert.equal(
		(client.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>).some(
			(column) => column.name === "project_root",
		),
		false,
	);
	client.close();
});

test("preserves corruption discovered during migration before rebuilding", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-corrupt-migration-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	createV1Catalog(path);
	const corrupted = new DatabaseSync(path);
	const pageSize = (corrupted.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
	const sessionPage = corrupted
		.prepare("SELECT pageno FROM dbstat WHERE name = 'session' AND pagetype = 'leaf'")
		.get() as { pageno: number };
	corrupted.close();
	const file = await open(path, "r+");
	await file.write(Buffer.alloc(pageSize), 0, pageSize, (sessionPage.pageno - 1) * pageSize);
	await file.close();
	const errors: string[] = [];
	t.mock.method(console, "error", (...values: unknown[]) => errors.push(values.map(String).join(" ")));

	Catalog.open(path).close();

	const preserved = (await readdir(root)).find(
		(name) => name.startsWith("catalog.db.corrupt-") && !name.endsWith("-wal") && !name.endsWith("-shm"),
	);
	assert(preserved);
	assert.match(errors.join("\n"), /became corrupt during migration/);
	const old = new DatabaseSync(join(root, preserved));
	assert.equal((old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
	old.close();
	const fresh = new DatabaseSync(path);
	assert.equal((fresh.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
	fresh.close();
});

test("fresh and migrated catalogs have equivalent structures", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-equivalence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const freshPath = join(root, "fresh.db");
	const migratedPath = join(root, "migrated.db");
	Catalog.open(freshPath).close();
	createV1Catalog(migratedPath);
	Catalog.open(migratedPath).close();

	const fresh = new DatabaseSync(freshPath);
	const migrated = new DatabaseSync(migratedPath);
	for (const table of ["node", "project", "workspace", "session"]) {
		for (const pragma of ["table_info", "foreign_key_list", "index_list"]) {
			assert.deepEqual(
				migrated.prepare(`PRAGMA ${pragma}(${table})`).all(),
				fresh.prepare(`PRAGMA ${pragma}(${table})`).all(),
				`${pragma} differs for ${table}`,
			);
		}
	}
	fresh.close();
	migrated.close();
});

test("refuses to open a catalog from a newer ker", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-downgrade-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	Catalog.open(path).close();
	const newer = new DatabaseSync(path);
	newer.exec("PRAGMA user_version = 99");
	newer.close();

	assert.throws(() => Catalog.open(path), /created by a newer ker — refusing to open/);
	const preserved = new DatabaseSync(path);
	assert.equal((preserved.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 99);
	preserved.close();
});

test("preserves a corrupt catalog before rebuilding", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-corrupt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	await writeFile(path, "not a sqlite database");
	const errors: string[] = [];
	t.mock.method(console, "error", (...values: unknown[]) => errors.push(values.map(String).join(" ")));

	const catalog = Catalog.open(path);
	catalog.close();

	const preserved = (await readdir(root)).find(
		(name) => name.startsWith("catalog.db.corrupt-") && !name.endsWith("-wal") && !name.endsWith("-shm"),
	);
	assert(preserved);
	assert.equal(await readFile(join(root, preserved), "utf8"), "not a sqlite database");
	assert.match(errors.join("\n"), /preserved it at .*catalog\.db\.corrupt-/);
	const client = new DatabaseSync(path);
	assert.equal((client.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
	client.close();
});

test("preserves a version-zero database with content before rebuilding", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-unversioned-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const unversioned = new DatabaseSync(path);
	unversioned.exec("CREATE TABLE legacy (value TEXT)");
	unversioned.exec("INSERT INTO legacy VALUES ('keep me')");
	unversioned.close();
	t.mock.method(console, "error", () => undefined);

	Catalog.open(path).close();

	const preserved = (await readdir(root)).find((name) => name.startsWith("catalog.db.corrupt-"));
	assert(preserved);
	const old = new DatabaseSync(join(root, preserved));
	assert.equal((old.prepare("SELECT value FROM legacy").get() as { value: string }).value, "keep me");
	old.close();
});

test("does not replace a catalog after an unrelated open error", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-open-error-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	assert.throws(() => Catalog.open(root), /unable to open database file/);
	assert.equal((await stat(root)).isDirectory(), true);
});

test("the DDL round-trips every schema column through Drizzle", () => {
	const client = new DatabaseSync(":memory:");
	client.exec("PRAGMA foreign_keys = ON");
	client.exec(DDL);
	const db = drizzle({ client });
	const createdAt = "2026-01-01T00:00:00.000Z";
	db.insert(node).values({ id: "node-1", name: "node", created_at: createdAt }).run();
	db.insert(project).values({ id: "project-1", name: "project", created_at: createdAt }).run();
	db.insert(workspace)
		.values({
			id: "workspace-1",
			project_id: "project-1",
			node_id: "node-1",
			root_path: "/project",
			git_remote: "git@example.com:project.git",
			created_at: createdAt,
		})
		.run();
	const expected = {
		id: "session-1",
		project_key: "project-key",
		cwd: "/project/nested",
		title: "First prompt",
		status: "busy" as const,
		error: "failure",
		created_at: createdAt,
		updated_at: "2026-01-02T00:00:00.000Z",
		project_id: "project-1",
		workspace_id: "workspace-1",
		node_id: "node-1",
	};
	db.insert(session).values(expected).run();
	assert.deepEqual(db.select().from(session).get(), expected);
	client.close();
});

test("upserts node names and returns the existing workspace after a duplicate create", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-binding-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const catalog = Catalog.open(path);
	t.after(() => catalog.close());
	catalog.upsertNode(IDENTITY);
	catalog.upsertNode({ ...IDENTITY, name: "renamed" });
	const first = catalog.createWorkspace({
		nodeId: IDENTITY.id,
		rootPath: "/project",
		projectName: "project",
		gitRemote: "first-remote",
	});
	const second = catalog.createWorkspace({
		nodeId: IDENTITY.id,
		rootPath: "/project",
		projectName: "duplicate",
		gitRemote: "second-remote",
	});

	assert.deepEqual(second, first);
	assert.deepEqual(catalog.findWorkspaceByRoot(IDENTITY.id, "/project"), first);
	const client = new DatabaseSync(path);
	assert.equal(
		(client.prepare("SELECT name FROM node WHERE id = ?").get(IDENTITY.id) as { name: string }).name,
		"renamed",
	);
	assert.equal((client.prepare("SELECT count(*) AS count FROM project").get() as { count: number }).count, 1);
	client.close();
});

test("reconcile binds sessions, preserves metadata, and keeps empty projects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-reconcile-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const catalog = Catalog.open(path);
	t.after(() => catalog.close());
	catalog.upsertNode(IDENTITY);
	const first = catalogedSession("session-1", "/project-a", "/project-a/one", true);
	const second = catalogedSession("session-2", "/project-a", "/project-a/two", false);
	const third = catalogedSession("session-3", "/project-b", "/project-b", true);
	catalog.reconcile({ sessions: [first, second, third], unreadable: [] }, IDENTITY.id);
	catalog.setTitleIfEmpty(first.session.id, "Saved title");
	const firstBinding = catalog.findWorkspaceByRoot(IDENTITY.id, "/project-a");
	const thirdBinding = catalog.findWorkspaceByRoot(IDENTITY.id, "/project-b");
	assert(firstBinding);
	assert(thirdBinding);
	assert.equal(catalog.get(first.session.id)?.project_id, firstBinding.projectId);
	assert.equal(catalog.get(second.session.id)?.project_id, firstBinding.projectId);
	assert.notEqual(firstBinding.projectId, thirdBinding.projectId);

	const updatedFirst = {
		...first,
		idle: false,
		session: { ...first.session, updatedAt: "2026-02-01T00:00:00.000Z" },
	};
	catalog.reconcile(
		{
			sessions: [updatedFirst, third],
			unreadable: [
				{ id: second.session.id, projectKey: second.projectKey, error: "broken tail" },
				{ id: "never-readable", projectKey: "unknown-project", error: "bad header" },
			],
		},
		IDENTITY.id,
	);
	assert.equal(catalog.get(first.session.id)?.title, "Saved title");
	assert.equal(catalog.get(first.session.id)?.status, "busy");
	assert.equal(catalog.get(second.session.id)?.project_id, firstBinding.projectId);
	assert.equal(catalog.get(second.session.id)?.status, "unreadable");
	assert.equal(catalog.get("never-readable")?.project_id, null);

	catalog.reconcile({ sessions: [], unreadable: [] }, IDENTITY.id);
	assert.deepEqual(catalog.list(), []);
	const client = new DatabaseSync(path);
	assert.equal((client.prepare("SELECT count(*) AS count FROM project").get() as { count: number }).count, 2);
	assert.equal((client.prepare("SELECT count(*) AS count FROM workspace").get() as { count: number }).count, 2);
	client.close();
});

test("catalog queries preserve order and use project-anchored scope", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-queries-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const catalog = Catalog.open(join(root, "catalog.db"));
	t.after(() => catalog.close());
	catalog.upsertNode(IDENTITY);
	const first = catalogedSession("session-1", "/project-a", "/project-a/one", true);
	const second = catalogedSession("session-2", "/project-a", "/project-a/two", true);
	const third = catalogedSession("session-3", "/project-b", "/project-b", true);
	second.session.createdAt = "2026-01-02T00:00:00.000Z";
	second.session.updatedAt = second.session.createdAt;
	third.session.createdAt = "2026-01-03T00:00:00.000Z";
	third.session.updatedAt = third.session.createdAt;
	catalog.reconcile(
		{
			sessions: [third, second, first],
			unreadable: [
				{ id: "unreadable-a", projectKey: first.projectKey, error: "broken" },
				{ id: "unreadable-missing", projectKey: projectKey("/missing"), error: "missing" },
			],
		},
		IDENTITY.id,
	);
	catalog.setTitleIfEmpty(first.session.id, "Original");
	catalog.setTitleIfEmpty(first.session.id, "Replacement");
	catalog.touch(first.session.id, { updatedAt: "2026-03-01T00:00:00.000Z", status: "busy" });

	assert.equal(catalog.get(first.session.id)?.title, "Original");
	assert.deepEqual(
		catalog.list().map((row) => row.id),
		["unreadable-a", "unreadable-missing", first.session.id, second.session.id, third.session.id],
	);
	assert.deepEqual(
		catalog.list({ nodeId: IDENTITY.id, rootPath: "/project-a" }).map((row) => row.id),
		["unreadable-a", first.session.id, second.session.id],
	);
	assert.deepEqual(
		catalog.list({ nodeId: IDENTITY.id, rootPath: "/missing" }).map((row) => row.id),
		["unreadable-missing"],
	);
	assert.equal(catalog.get(first.session.id)?.status, "busy");
	assert.equal(catalog.get(first.session.id)?.updated_at, "2026-03-01T00:00:00.000Z");
});

test("project queries compute session activity and keep empty projects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-catalog-project-list-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const catalog = Catalog.open(join(root, "catalog.db"));
	t.after(() => catalog.close());
	catalog.upsertNode(IDENTITY);
	const first = catalogedSession("session-1", "/project-a", "/project-a/one", true);
	const second = catalogedSession("session-2", "/project-a", "/project-a/two", true);
	second.session.updatedAt = "2026-02-01T00:00:00.000Z";
	catalog.reconcile({ sessions: [first, second], unreadable: [] }, IDENTITY.id);
	const binding = catalog.findWorkspaceByRoot(IDENTITY.id, "/project-a");
	assert(binding);
	catalog.markUnreadable(second.session.id, "broken");
	const empty = catalog.createWorkspace({
		nodeId: IDENTITY.id,
		rootPath: "/project-empty",
		projectName: "empty",
		gitRemote: null,
	});

	assert.equal(catalog.projectExists(binding.projectId), true);
	assert.equal(catalog.projectExists("missing"), false);
	assert.deepEqual(
		catalog.list({ projectId: binding.projectId }).map((row) => row.id),
		[first.session.id, second.session.id],
	);
	assert.deepEqual(
		catalog.listProjects().find((candidate) => candidate.id === binding.projectId),
		{
			id: binding.projectId,
			name: "project-a",
			createdAt: catalog.listProjects().find((candidate) => candidate.id === binding.projectId)?.createdAt,
			sessionCount: 2,
			lastActivityAt: second.session.updatedAt,
		},
	);
	assert.deepEqual(
		catalog.listProjects().find((candidate) => candidate.id === empty.projectId),
		{
			id: empty.projectId,
			name: "empty",
			createdAt: catalog.listProjects().find((candidate) => candidate.id === empty.projectId)?.createdAt,
			sessionCount: 0,
			lastActivityAt: null,
		},
	);
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

function createV1Catalog(path: string): void {
	const client = new DatabaseSync(path);
	client.exec(V1_DDL);
	client
		.prepare(
			"INSERT INTO session (id, project_key, project_root, cwd, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"session-old",
			"project-key",
			"/project",
			"/project",
			"Saved title",
			"idle",
			"2026-01-01T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z",
		);
	client.exec("PRAGMA user_version = 1");
	client.close();
}

function sessionDescriptor(id: string, projectRoot: string, cwd: string): Protocol.SessionDescriptor {
	return {
		id,
		projectRoot,
		cwd,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function catalogedSession(id: string, projectRoot: string, cwd: string, idle: boolean): CatalogedSession {
	const key = projectKey(projectRoot);
	return {
		session: sessionDescriptor(id, projectRoot, cwd),
		path: join("/sessions", key, id, "session.jsonl"),
		projectKey: key,
		idle,
	};
}
