import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultNodePath, loadNodeIdentity } from "../src/node.ts";

test("mints a private node identity and reloads it stably", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-identity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "nested", "node.json");

	const minted = loadNodeIdentity(path);
	const reloaded = loadNodeIdentity(path);

	assert.deepEqual(reloaded, minted);
	assert(minted.id.length > 0);
	assert(minted.name.length > 0);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(join(root, "nested"))).mode & 0o777, 0o700);
});

test("rejects invalid node identity content and names the file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-invalid-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const invalidJson = join(root, "invalid-json.json");
	const invalidShape = join(root, "invalid-shape.json");
	await writeFile(invalidJson, "not-json");
	await writeFile(invalidShape, JSON.stringify({ id: "node-1", name: "node" }));

	assert.throws(() => loadNodeIdentity(invalidJson), new RegExp(`Invalid node identity in ${invalidJson}`));
	assert.throws(() => loadNodeIdentity(invalidShape), new RegExp(`Invalid node identity in ${invalidShape}`));
});

test("uses KER_NODE_PATH before the user-owned default", (t) => {
	const previous = process.env.KER_NODE_PATH;
	delete process.env.KER_NODE_PATH;
	t.after(() => {
		if (previous === undefined) delete process.env.KER_NODE_PATH;
		if (previous !== undefined) process.env.KER_NODE_PATH = previous;
	});

	assert.equal(defaultNodePath(), join(homedir(), ".ker", "node.json"));
	process.env.KER_NODE_PATH = join(tmpdir(), "ker-custom-node.json");
	assert.equal(defaultNodePath(), join(tmpdir(), "ker-custom-node.json"));
});
