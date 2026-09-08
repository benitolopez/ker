import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Spool } from "../src/spool.ts";

test("persists pending records, reloads them, and removes acknowledged files", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ker-spool-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const spool = new Spool(directory);
	await spool.open("session-1", null);
	const records = await spool.append("session-1", [
		{
			type: "stats",
			contextTokens: 1,
			model: null,
		},
	]);
	const path = join(directory, "session-1.jsonl");
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.equal((await stat(path)).mode & 0o777, 0o600);

	const reloaded = new Spool(directory);
	const pending = await reloaded.drain();
	assert.deepEqual(pending.get("session-1"), records);
	const recordId = records[0]?.recordId;
	assert(recordId);
	await reloaded.acknowledge("session-1", recordId);
	assert.equal(existsSync(path), false);
	await reloaded.open("session-1", "plane-head");
	const continued = await reloaded.append("session-1", [{ type: "stats", contextTokens: 2, model: null }]);
	assert.equal(continued[0]?.previousRecordId, "plane-head");
});
