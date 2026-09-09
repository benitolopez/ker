import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Catalog, hashSecret } from "../src/catalog.ts";
import { CATALOG_VERSION, DDL } from "../src/schema.ts";

test("devices and settings persist, update, and delete without storing raw credentials", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-devices-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const catalog = Catalog.open(path);
	const device = catalog.createDevice("Phone", hashSecret("secret"));
	assert.equal(device.last_seen_at, null);
	assert.equal(catalog.findDeviceByTokenHash("secret"), undefined);
	assert.deepEqual(catalog.findDeviceByTokenHash(hashSecret("secret")), device);
	catalog.touchDevice(device.id, "2026-09-09T12:00:00.000Z");
	assert.equal(catalog.listDevices()[0]?.last_seen_at, "2026-09-09T12:00:00.000Z");
	assert.equal(catalog.getSetting("public_url"), undefined);
	catalog.setSetting("public_url", "https://ker.test");
	catalog.setSetting("public_url", "https://new.test");
	const code = catalog.createOneTimeToken("device");
	assert.equal(catalog.consumeOneTimeToken("node", code.token), "invalid");
	assert.equal(catalog.consumeOneTimeToken("device", code.token), "ok");
	assert.equal(catalog.consumeOneTimeToken("device", code.token), "used");
	const node = catalog.createOneTimeToken("node");
	assert.equal(catalog.consumeOneTimeToken("device", node.token), "invalid");
	assert.equal(catalog.consumeOneTimeToken("node", node.token), "ok");
	catalog.close();
	const reopened = Catalog.open(path);
	t.after(() => reopened.close());
	assert.equal(reopened.getSetting("public_url"), "https://new.test");
	assert.equal(reopened.deleteDevice(device.id)?.name, "Phone");
	assert.equal(reopened.deleteDevice(device.id), undefined);
	assert.deepEqual(reopened.listDevices(), []);
	reopened.deleteSetting("public_url");
	assert.equal(reopened.getSetting("public_url"), undefined);
});

test("v4 migration preserves every existing entity and gives enrollment tokens the node kind", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-v4-devices-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const client = new DatabaseSync(path);
	client.exec(DDL);
	client.exec(
		"DROP TABLE device; DROP TABLE setting; ALTER TABLE one_time_token DROP COLUMN kind; ALTER TABLE one_time_token RENAME TO enrollment_token; PRAGMA user_version = 4",
	);
	client.exec(
		"INSERT INTO node (id, name, created_at) VALUES ('node', 'Laptop', 'date'); INSERT INTO project VALUES ('project', 'Project', 'date'); INSERT INTO workspace VALUES ('workspace', 'project', 'node', '/work', NULL, 'date'); INSERT INTO document VALUES ('document', 'project', 'Title', 'Body', 'date', 'date'); INSERT INTO session (id, project_key, status, project_id, workspace_id, node_id, title) VALUES ('session', 'key', 'idle', 'project', 'workspace', 'node', 'Saved')",
	);
	client
		.prepare("INSERT INTO enrollment_token VALUES ('token', ?, 'date', '2099-01-01', NULL)")
		.run(hashSecret("enrollment"));
	const tables = ["node", "project", "workspace", "session", "document"];
	const before = tables.map((table) => client.prepare(`SELECT * FROM ${table}`).all());
	client.close();
	const migrated = Catalog.open(path);
	t.after(() => migrated.close());
	const check = new DatabaseSync(path);
	t.after(() => check.close());
	assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, CATALOG_VERSION);
	assert.deepEqual(
		tables.map((table) => check.prepare(`SELECT * FROM ${table}`).all()),
		before,
	);
	assert.equal(check.prepare("SELECT kind FROM one_time_token").get()?.kind, "node");
	assert.equal(migrated.consumeOneTimeToken("device", "enrollment"), "invalid");
	assert.equal(migrated.consumeOneTimeToken("node", "enrollment"), "ok");
	assert.deepEqual(migrated.listDevices(), []);
});

test("a rebuild salvages devices, settings, and unspent pairing codes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-device-salvage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const catalog = Catalog.open(path);
	const device = catalog.createDevice("Phone", hashSecret("secret"));
	const pairing = catalog.createOneTimeToken("device");
	catalog.setSetting("public_url", "https://ker.test");
	catalog.close();
	const damaged = new DatabaseSync(path);
	damaged.exec("PRAGMA user_version = 0");
	damaged.close();
	t.mock.method(console, "error", () => undefined);
	const recovered = Catalog.open(path);
	t.after(() => recovered.close());
	assert.deepEqual(recovered.findDeviceByTokenHash(hashSecret("secret")), device);
	assert.equal(recovered.getSetting("public_url"), "https://ker.test");
	assert.equal(recovered.consumeOneTimeToken("device", pairing.token), "ok");
});
