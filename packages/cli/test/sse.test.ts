import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { test } from "node:test";
import { sseData } from "../src/sse.ts";

// Deliver each string as its own chunk so a test can split one SSE frame across chunk boundaries.
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(encoder.encode(chunks[i++]));
				return;
			}
			controller.close();
		},
	});
}

async function collect(chunks: string[]): Promise<string[]> {
	const out: string[] = [];
	for await (const data of sseData(streamFrom(chunks))) out.push(data);
	return out;
}

test("yields the data payload of a single frame", async () => {
	assert.deepEqual(await collect(["data: hello\n\n"]), ["hello"]);
});

test("strips only one leading space after data:", async () => {
	assert.deepEqual(await collect(["data:  hello\n\n"]), [" hello"]);
});

test("joins multiple data lines in one frame with newlines", async () => {
	assert.deepEqual(await collect(["data: a\ndata: b\n\n"]), ["a\nb"]);
});

test("tolerates CRLF line endings", async () => {
	assert.deepEqual(await collect(["data: x\r\n\r\n"]), ["x"]);
});

test("reassembles a frame split across chunk boundaries", async () => {
	assert.deepEqual(await collect(["data: hel", "lo\n", "\n"]), ["hello"]);
});

test("ignores comment (heartbeat) and id lines", async () => {
	assert.deepEqual(await collect([": hb\n\n", "id: 4\ndata: y\n\n"]), ["y"]);
});

test("emits nothing for an unterminated frame", async () => {
	assert.deepEqual(await collect(["data: partial"]), []);
});

test("emits nothing for a blank line with no preceding data", async () => {
	assert.deepEqual(await collect(["\n\n"]), []);
});
