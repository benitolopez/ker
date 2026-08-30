import assert from "node:assert/strict";
import { test } from "node:test";
import { sseData } from "../src/sse.ts";

test("cancels the stream when iteration stops early", async () => {
	const encoder = new TextEncoder();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("data: first\n\n"));
		},
		cancel() {
			cancelled = true;
		},
	});
	const iterator = sseData(stream);

	assert.deepEqual(await iterator.next(), { done: false, value: "first" });
	await iterator.return(undefined);
	assert.equal(cancelled, true);
});
