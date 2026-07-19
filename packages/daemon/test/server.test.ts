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
		const created = await localFetch(`${running.url}/conversation/new`, { method: "POST" });
		assert.equal(created.status, 201);
		const replacement = await readJson<{ sessionId: string }>(created.body);
		assert.notEqual(replacement.sessionId, initial.sessionId);

		const stale = await prompt(running.url, "stale", initial.sessionId);
		assert.equal(stale.status, 412);
		assert.deepEqual(state.prompts, []);

		const current = await health(running.url);
		assert.equal(current.sessionId, replacement.sessionId);
		assert.equal((await prompt(running.url, "current", current.sessionId)).status, 202);
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
		const current = await health(running.url);
		assert.equal((await prompt(running.url, "wait", current.sessionId)).status, 202);
		await started.promise;
		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 409);
		assert.equal(state.resetCalls, 0);

		release.resolve();
		await finished.promise;
		await setImmediate();
		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 201);
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
		const initial = await health(running.url);

		assert.equal((await prompt(running.url, "first", initial.sessionId)).status, 202);
		const firstMessage = parseFrame(await nextFrame(frames));
		const firstEnd = parseFrame(await nextFrame(frames));
		await state.finished.promise;
		await setImmediate();

		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 201);
		const reset = parseFrame(await nextFrame(frames));
		const current = await health(running.url);
		assert.equal((await prompt(running.url, "second", current.sessionId)).status, 202);
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

test("aborts only the named active turn and responds after cleanup", async () => {
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const harness: Harness = {
		reset() {},
		async *send(_text, signal) {
			started.resolve();
			await new Promise<void>((resolve) => {
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			aborted.resolve();
			yield { role: "assistant", type: "aborted" };
			await cleanup.promise;
			yield { role: "assistant", type: "end" };
		},
	};
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		const accepted = await prompt(running.url, "wait", current.sessionId);
		const { turnId } = await readJson<{ turnId: string }>(accepted.body);
		await started.promise;

		assert.equal((await abort(running.url, "wrong-session", turnId)).status, 409);
		assert.equal((await abort(running.url, current.sessionId, "wrong-turn")).status, 409);

		const aborting = abort(running.url, current.sessionId, turnId);
		await aborted.promise;
		assert.equal(parseFrame(await nextFrame(frames)).event.type, "aborted");
		assert.equal(await Promise.race([aborting.then(() => "done"), setImmediate().then(() => "cleaning")]), "cleaning");

		cleanup.resolve();
		assert.equal(parseFrame(await nextFrame(frames)).event.type, "end");
		assert.equal((await aborting).status, 204);
		assert.equal((await abort(running.url, current.sessionId, turnId)).status, 409);
		await frames.return?.(undefined);
	} finally {
		cleanup.resolve();
		await running.close();
	}
});

test("unexpected harness failures still end the event stream", async () => {
	const harness: Harness = {
		reset() {},
		send() {
			return {
				[Symbol.asyncIterator]: () => ({
					next: async (): Promise<IteratorResult<Protocol.Event>> => {
						throw new Error("pump failed");
					},
				}),
			};
		},
	};
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		assert.equal((await prompt(running.url, "fail", current.sessionId)).status, 202);
		assert.deepEqual(parseFrame(await nextFrame(frames)).event, {
			role: "assistant",
			type: "error",
			message: "pump failed",
		});
		assert.equal(parseFrame(await nextFrame(frames)).event.type, "end");
		await frames.return?.(undefined);
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

async function health(url: string): Promise<{ sessionId: string }> {
	const response = await localFetch(`${url}/health`);
	assert.equal(response.status, 200);
	return readJson(response.body);
}

function prompt(url: string, text: string, sessionId: string): Promise<TestResponse> {
	return localFetch(`${url}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text, sessionId }),
	});
}

function abort(url: string, sessionId: string, turnId: string): Promise<TestResponse> {
	return localFetch(`${url}/turn/abort`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId, turnId }),
	});
}

async function readJson<T>(body: AsyncIterable<Uint8Array>): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of body) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
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
