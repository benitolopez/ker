import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { OutputAccumulator, truncateTail } from "../src/bash-output.ts";
import { MAX_OUTPUT_BYTES } from "../src/output-limits.ts";

test("keeps short output in memory without creating a spill", async () => {
	const output = new OutputAccumulator({ maxLines: 3, maxBytes: 16, maxSpillBytes: 64 });
	output.append(Buffer.from("one\ntwo"));
	assert.deepEqual(await output.finish(), {
		text: "one\ntwo",
		truncated: false,
		shown: 2,
		total: 2,
	});
});

test("preserves a leading UTF-8 BOM split across streamed chunks", async () => {
	const content = "\uFEFFshort";
	const output = new OutputAccumulator();
	for (const byte of Buffer.from(content)) output.append(Buffer.from([byte]));
	assert.deepEqual(await output.finish(), {
		text: content,
		truncated: false,
		shown: 1,
		total: 1,
	});
});

test("streams complete output to a private spill while retaining the bounded tail", async () => {
	const output = new OutputAccumulator({ maxLines: 2, maxBytes: 100, maxSpillBytes: 1000 });
	output.append(Buffer.from("one\ntwo\n"));
	output.append(Buffer.from("three\nfour\n"));
	const snapshot = await output.finish();
	assert.equal(snapshot.text, "three\nfour");
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.shown, 2);
	assert.equal(snapshot.total, 4);
	assert.ok(snapshot.path);
	assert.equal(await readFile(snapshot.path, "utf8"), "one\ntwo\nthree\nfour\n");
	assert.equal((await stat(snapshot.path)).mode & 0o777, 0o600);
	assert.equal((await stat(dirname(snapshot.path))).mode & 0o777, 0o700);
});

test("stops at the spill limit without writing bytes beyond it", async () => {
	const stops = { count: 0 };
	const output = new OutputAccumulator({
		maxLines: 100,
		maxBytes: 4,
		maxSpillBytes: 8,
		stop: () => {
			stops.count++;
		},
	});
	output.append(Buffer.from("abcdefghijkl"));
	const snapshot = await output.finish();
	assert.equal(output.limitReached, true);
	assert.equal(output.failure, undefined);
	assert.equal(stops.count, 1);
	assert.equal(snapshot.text, "efgh");
	assert.ok(snapshot.path);
	assert.equal(await readFile(snapshot.path, "utf8"), "abcdefgh");
});

test("decodes split UTF-8 chunks without corrupting the rolling tail", async () => {
	const raw = Buffer.from(`start\n${"€".repeat(20)}`);
	const output = new OutputAccumulator({ maxLines: 10, maxBytes: 12, maxSpillBytes: 1000 });
	for (const byte of raw) output.append(Buffer.from([byte]));
	const snapshot = await output.finish();
	assert.equal(snapshot.text, "€".repeat(4));
	assert.ok(!snapshot.text.includes("�"));
	assert.ok(snapshot.path);
	assert.deepEqual(await readFile(snapshot.path), raw);
});

test("retains the byte-limited tail of an oversized final line ending in a newline", async () => {
	const content = `${"x".repeat(MAX_OUTPUT_BYTES * 4)}\n`;
	const output = new OutputAccumulator();
	output.append(Buffer.from(content));
	const snapshot = await output.finish();
	assert.equal(snapshot.text, "x".repeat(MAX_OUTPUT_BYTES));
	assert.equal(snapshot.shown, 1);
	assert.equal(snapshot.total, 1);
	assert.equal(snapshot.truncated, true);
	assert.ok(snapshot.path);
	assert.equal(await readFile(snapshot.path, "utf8"), content);
});

test("matches full-content tail truncation across chunked oversized final lines", async () => {
	const maxLines = 4;
	const maxBytes = 31;
	const contents = [
		`${"x".repeat(maxBytes * 8)}\n`,
		`prefix\n${"y".repeat(maxBytes * 8)}\n`,
		`prefix\n${"€".repeat(maxBytes * 3)}\n`,
	];

	for (const content of contents) {
		const raw = Buffer.from(content);
		for (const chunkSize of [1, maxBytes - 1, maxBytes, maxBytes + 1, maxBytes * 4]) {
			const output = new OutputAccumulator({ maxLines, maxBytes, maxSpillBytes: 1000 });
			for (let offset = 0; offset < raw.length; offset += chunkSize) {
				output.append(raw.subarray(offset, offset + chunkSize));
			}
			const snapshot = await output.finish();
			const expected = truncateTail(content, { maxLines, maxBytes });
			const context = `content ${raw.length} bytes in ${chunkSize}-byte chunks`;
			assert.equal(snapshot.text, expected.text, context);
			assert.equal(snapshot.shown, expected.shown, context);
			assert.equal(snapshot.total, expected.total, context);
			assert.equal(snapshot.truncated, expected.truncated, context);
		}
	}
});

test("recreates the private spill directory if the active directory disappears", async () => {
	const first = new OutputAccumulator({ maxBytes: 4, maxSpillBytes: 100 });
	first.append(Buffer.from("first spill"));
	const firstSnapshot = await first.finish();
	assert.ok(firstSnapshot.path);
	const firstDirectory = dirname(firstSnapshot.path);
	const exitListeners = process.listenerCount("exit");
	await rm(firstDirectory, { recursive: true, force: true });

	const stops = { count: 0 };
	const second = new OutputAccumulator({
		maxBytes: 4,
		maxSpillBytes: 100,
		stop: () => {
			stops.count++;
		},
	});
	second.append(Buffer.from("second spill"));
	const secondSnapshot = await second.finish();
	assert.equal(second.failure, undefined);
	assert.equal(stops.count, 0);
	assert.ok(secondSnapshot.path);
	assert.notEqual(dirname(secondSnapshot.path), firstDirectory);
	assert.equal(await readFile(secondSnapshot.path, "utf8"), "second spill");
	assert.equal((await stat(secondSnapshot.path)).mode & 0o777, 0o600);
	assert.equal((await stat(dirname(secondSnapshot.path))).mode & 0o777, 0o700);
	assert.equal(process.listenerCount("exit"), exitListeners);
});
