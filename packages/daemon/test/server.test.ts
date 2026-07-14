import assert from "node:assert/strict";
import { type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type * as Protocol from "@ker-ai/protocol";
import { createDaemon } from "../src/index.ts";

const LOCAL_HOST = "127.0.0.1:5537";

type Harness = NonNullable<Parameters<typeof createDaemon>[0]>;

test("rejects a prompt composed before another client reset the conversation", async () => {
	const { harness, state } = createImmediateHarness();
	const running = await startServer(harness);
	try {
		const initial = await health(running.url);
		assert.equal(initial.generation, 0);
		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 204);

		const stale = await prompt(running.url, "stale", initial.generation);
		assert.equal(stale.status, 412);
		assert.deepEqual(state.prompts, []);

		const current = await health(running.url);
		assert.equal(current.generation, 1);
		assert.equal((await prompt(running.url, "current", current.generation)).status, 202);
		await state.finished.promise;
		assert.deepEqual(state.prompts, ["current"]);
	} finally {
		await running.close();
	}
});

test("rejects reset while a turn is running", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const state = { resetCalls: 0 };
	const harness: Harness = {
		reset() {
			state.resetCalls++;
		},
		async *send() {
			started.resolve();
			await release.promise;
			yield { role: "assistant", type: "end" };
			finished.resolve();
		},
	};
	const running = await startServer(harness);
	try {
		assert.equal((await prompt(running.url, "wait", 0)).status, 202);
		await started.promise;
		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 409);
		assert.equal(state.resetCalls, 0);

		release.resolve();
		await finished.promise;
		await setImmediate();
		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 204);
		assert.equal(state.resetCalls, 1);
	} finally {
		release.resolve();
		await running.close();
	}
});

test("broadcasts reset and keeps event ids monotonic after trimming the old log", async () => {
	const { harness, state } = createImmediateHarness();
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert.equal(events.status, 200);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();

		assert.equal((await prompt(running.url, "first", 0)).status, 202);
		const firstMessage = parseFrame(await nextFrame(frames));
		const firstEnd = parseFrame(await nextFrame(frames));
		await state.finished.promise;
		await setImmediate();

		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 204);
		const reset = parseFrame(await nextFrame(frames));
		const current = await health(running.url);
		assert.equal((await prompt(running.url, "second", current.generation)).status, 202);
		const secondMessage = parseFrame(await nextFrame(frames));
		const secondEnd = parseFrame(await nextFrame(frames));

		assert.deepEqual([firstMessage.id, firstEnd.id, reset.id, secondMessage.id, secondEnd.id], [0, 1, 2, 3, 4]);
		assert.equal(firstMessage.event.type, "message_delta");
		assert.equal(firstEnd.event.type, "end");
		assert.deepEqual(reset.event, { role: "system", type: "conversation_reset" });
		assert.equal(secondMessage.event.type, "message_delta");
		assert.equal(secondEnd.event.type, "end");
		assert.equal(state.resetCalls, 1);
		assert.deepEqual(state.prompts, ["first", "second"]);
		await frames.return?.(undefined);
	} finally {
		await running.close();
	}
});

test("guards the event stream by host and origin", async () => {
	const { harness } = createImmediateHarness();
	const running = await startServer(harness);
	try {
		assert.equal((await fetch(`${running.url}/event`)).status, 403);
		assert.equal(
			(
				await localFetch(`${running.url}/event`, {
					headers: { origin: "https://example.com" },
				})
			).status,
			403,
		);

		const allowed = await localFetch(`${running.url}/event`);
		assert.equal(allowed.status, 200);
		allowed.body.destroy();
	} finally {
		await running.close();
	}
});

function createImmediateHarness(): {
	harness: Harness;
	state: { prompts: string[]; resetCalls: number; finished: PromiseWithResolvers<void> };
} {
	const state = { prompts: [] as string[], resetCalls: 0, finished: Promise.withResolvers<void>() };
	return {
		state,
		harness: {
			reset() {
				state.resetCalls++;
			},
			async *send(text) {
				state.prompts.push(text);
				yield { role: "assistant", type: "message_delta", text };
				yield { role: "assistant", type: "end" };
				state.finished.resolve();
			},
		},
	};
}

async function startServer(harness: Harness): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createDaemon(harness);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		url: `http://127.0.0.1:${(address as AddressInfo).port}`,
		close: () => closeServer(server),
	};
}

async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

interface TestResponse {
	status: number;
	body: IncomingMessage;
}

function localFetch(
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<TestResponse> {
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: init?.method,
				headers: { ...init?.headers, host: LOCAL_HOST },
			},
			(res) => resolve({ status: res.statusCode ?? 0, body: res }),
		);
		req.on("error", reject);
		req.end(init?.body);
	});
}

async function health(url: string): Promise<{ generation: number }> {
	const response = await localFetch(`${url}/health`);
	assert.equal(response.status, 200);
	const chunks: Buffer[] = [];
	for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { generation: number };
}

function prompt(url: string, text: string, generation: number): Promise<TestResponse> {
	return localFetch(`${url}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text, generation }),
	});
}

async function* readFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			if (frame && !frame.startsWith(":")) yield frame;
		}
	}
}

async function nextFrame(frames: AsyncIterator<string>): Promise<string> {
	const next = await frames.next();
	assert.equal(next.done, false);
	return next.value;
}

function parseFrame(frame: string): { id: number; event: Protocol.Event } {
	const id = frame.match(/^id: (\d+)$/m)?.[1];
	const data = frame.match(/^data: (.+)$/m)?.[1];
	assert(id);
	assert(data);
	return { id: Number(id), event: JSON.parse(data) as Protocol.Event };
}
