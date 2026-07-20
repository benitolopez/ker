import assert from "node:assert/strict";
import { type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { createDaemon } from "../src/index.ts";

const LOCAL_HOST = "127.0.0.1:5537";

type Harness = NonNullable<Parameters<typeof createDaemon>[0]>;

test("runs an idle submission through submitted, delivered, and end with correlated ids", async () => {
	const { harness, state } = createImmediateHarness();
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		const response = await prompt(running.url, "hello", current.sessionId);
		assert.equal(response.status, 202);
		const accepted = await readJson<Protocol.MessageSubmittedEvent>(response.body);
		const turnEvents = await readThroughEnd(frames, accepted.turnId);

		assert.deepEqual(turnEvents[0].event, accepted);
		assert.deepEqual(accepted, {
			actor: "human",
			sessionId: current.sessionId,
			turnId: accepted.turnId,
			type: "message_submitted",
			messageId: accepted.messageId,
			text: "hello",
			queued: false,
		});
		assert.deepEqual(
			turnEvents.map(({ event }) => event),
			[
				accepted,
				{
					actor: "human",
					modelRole: "user",
					sessionId: current.sessionId,
					turnId: accepted.turnId,
					type: "message_delivered",
					messageId: accepted.messageId,
					text: "hello",
				},
				{
					actor: "agent",
					modelRole: "assistant",
					sessionId: current.sessionId,
					turnId: accepted.turnId,
					type: "message_delta",
					text: "hello",
				},
				{
					actor: "process",
					sessionId: current.sessionId,
					turnId: accepted.turnId,
					type: "end",
				},
			],
		);
		assert(turnEvents.every(({ event }) => event.sessionId === current.sessionId));
		assert(turnEvents.every(({ event }) => !("role" in event)));
		assert.deepEqual(state.prompts, ["hello"]);
		await frames.return?.(undefined);
	} finally {
		await running.close();
	}
});

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

		const accepted = await prompt(running.url, "current", replacement.sessionId);
		assert.equal(accepted.status, 202);
		await state.finished.promise;
		assert.deepEqual(state.prompts, ["current"]);
	} finally {
		await running.close();
	}
});

test("broadcasts reset with its new session id and keeps SSE cursors monotonic", async () => {
	const { harness, state } = createImmediateHarness();
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const initial = await health(running.url);

		const firstResponse = await prompt(running.url, "first", initial.sessionId);
		const first = await readJson<Protocol.MessageSubmittedEvent>(firstResponse.body);
		const firstEvents = await readThroughEnd(frames, first.turnId);
		await setImmediate();

		const created = await localFetch(`${running.url}/conversation/new`, { method: "POST" });
		assert.equal(created.status, 201);
		const replacement = await readJson<{ sessionId: string }>(created.body);
		const reset = parseFrame(await nextFrame(frames));
		assert.deepEqual(reset.event, {
			actor: "process",
			sessionId: replacement.sessionId,
			type: "conversation_reset",
		});
		assert(!("turnId" in reset.event));

		const secondResponse = await prompt(running.url, "second", replacement.sessionId);
		const second = await readJson<Protocol.MessageSubmittedEvent>(secondResponse.body);
		const secondEvents = await readThroughEnd(frames, second.turnId);
		const cursors = [...firstEvents, reset, ...secondEvents].map(({ id }) => id);
		assert.deepEqual(
			cursors,
			cursors.map((_, index) => index),
		);
		assert.equal(new Set(cursors).size, cursors.length);
		assert.notEqual(first.messageId, second.messageId);
		assert.notEqual(first.turnId, second.turnId);
		assert.equal(state.resetCalls, 1);
		await frames.return?.(undefined);
	} finally {
		await running.close();
	}
});

test("queues active submissions in FIFO order on the existing turn", async () => {
	const streaming = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const state = {
		sendCalls: 0,
		providerUsers: [] as string[][],
		finished: Promise.withResolvers<void>(),
	};
	const harness: Harness = {
		reset() {},
		async *send(input) {
			state.sendCalls++;
			const users = [input.initial.text];
			state.providerUsers.push([...users]);
			yield delivered(input.initial);
			streaming.resolve();
			await release.promise;
			yield delta(input.initial, "first response");
			for (let next = input.takeSteering(true); next; next = input.takeSteering(true)) {
				users.push(next.text);
				yield delivered(next);
				state.providerUsers.push([...users]);
				yield delta(next, `${next.text} response`);
			}
			state.finished.resolve();
			yield end(input.initial);
		},
	};
	const running = await startServer(harness);
	try {
		const current = await health(running.url);
		const firstResponse = await prompt(running.url, "first", current.sessionId);
		const first = await readJson<Protocol.MessageSubmittedEvent>(firstResponse.body);
		await streaming.promise;

		const second = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "second", current.sessionId)).body,
		);
		const third = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "third", current.sessionId)).body,
		);
		assert.equal(second.queued, true);
		assert.equal(third.queued, true);
		assert.equal(second.turnId, first.turnId);
		assert.equal(third.turnId, first.turnId);

		release.resolve();
		await state.finished.promise;
		await setImmediate();
		assert.equal(state.sendCalls, 1);
		assert.deepEqual(state.providerUsers, [["first"], ["first", "second"], ["first", "second", "third"]]);
	} finally {
		release.resolve();
		await running.close();
	}
});

test("finishes every requested tool before delivering steering", async () => {
	const toolStarted = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();
	const state = { toolsFinished: 0 };
	const harness: Harness = {
		reset() {},
		async *send(input) {
			yield delivered(input.initial);
			yield toolCall(input.initial, "call-1", "first");
			yield toolCall(input.initial, "call-2", "second");
			toolStarted.resolve();
			await releaseTool.promise;
			state.toolsFinished++;
			yield toolResult(input.initial, "call-1", "first");
			state.toolsFinished++;
			yield toolResult(input.initial, "call-2", "second");
			const steering = input.takeSteering(false);
			assert(steering);
			assert.equal(state.toolsFinished, 2);
			yield delivered(steering);
			assert.equal(input.takeSteering(true), undefined);
			yield end(input.initial);
		},
	};
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		const first = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "first", current.sessionId)).body,
		);
		await toolStarted.promise;
		const queued = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "steer", current.sessionId)).body,
		);
		releaseTool.resolve();

		const turnEvents = (await readThroughEnd(frames, first.turnId)).map(({ event }) => event);
		const deliveredIndex = turnEvents.findIndex(
			(event) => event.type === "message_delivered" && event.messageId === queued.messageId,
		);
		const resultIndexes = turnEvents.flatMap((event, index) => (event.type === "tool_result" ? [index] : []));
		assert.equal(resultIndexes.length, 2);
		assert(resultIndexes.every((index) => index < deliveredIndex));
		assert.equal(queued.turnId, first.turnId);
		await frames.return?.(undefined);
	} finally {
		releaseTool.resolve();
		await running.close();
	}
});

test("admits before atomic closure and starts a new turn after closure cleanup", async () => {
	const boundaryReady = Promise.withResolvers<void>();
	const closeBoundary = Promise.withResolvers<void>();
	const finalReady = Promise.withResolvers<void>();
	const closeFinal = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const state = { sendCalls: 0 };
	const harness: Harness = {
		reset() {},
		async *send(input) {
			state.sendCalls++;
			yield delivered(input.initial);
			if (state.sendCalls > 1) {
				assert.equal(input.takeSteering(true), undefined);
				yield end(input.initial);
				return;
			}
			boundaryReady.resolve();
			await closeBoundary.promise;
			const before = input.takeSteering(true);
			assert(before);
			yield delivered(before);
			finalReady.resolve();
			await closeFinal.promise;
			assert.equal(input.takeSteering(true), undefined);
			closed.resolve();
			await cleanup.promise;
			yield end(input.initial);
		},
	};
	const running = await startServer(harness);
	try {
		const current = await health(running.url);
		const first = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "first", current.sessionId)).body,
		);
		await boundaryReady.promise;
		const before = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "before", current.sessionId)).body,
		);
		assert.equal(before.queued, true);
		assert.equal(before.turnId, first.turnId);
		closeBoundary.resolve();
		await finalReady.promise;
		closeFinal.resolve();
		await closed.promise;

		const afterResponse = prompt(running.url, "after", current.sessionId);
		assert.equal(
			await Promise.race([afterResponse.then(() => "responded"), setImmediate().then(() => "waiting")]),
			"waiting",
		);
		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 409);
		cleanup.resolve();
		const after = await readJson<Protocol.MessageSubmittedEvent>((await afterResponse).body);
		assert.equal(after.queued, false);
		assert.notEqual(after.turnId, first.turnId);
		assert.equal(state.sendCalls, 2);
	} finally {
		closeBoundary.resolve();
		closeFinal.resolve();
		cleanup.resolve();
		await running.close();
	}
});

test("aborts the named turn, marks queued messages undelivered in FIFO order, and waits through cleanup", async () => {
	const active = Promise.withResolvers<void>();
	const abortSeen = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const state = { sendCalls: 0 };
	const harness: Harness = {
		reset() {},
		async *send(input, signal) {
			state.sendCalls++;
			yield delivered(input.initial);
			if (state.sendCalls > 1) {
				assert.equal(input.takeSteering(true), undefined);
				yield end(input.initial);
				return;
			}
			active.resolve();
			await waitForAbort(signal);
			yield aborted(input.initial);
			abortSeen.resolve();
			await cleanup.promise;
			yield end(input.initial);
		},
	};
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		const first = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "first", current.sessionId)).body,
		);
		await active.promise;
		const second = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "second", current.sessionId)).body,
		);
		const third = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "third", current.sessionId)).body,
		);

		assert.equal((await abort(running.url, "wrong-session", first.turnId)).status, 409);
		assert.equal((await abort(running.url, current.sessionId, "wrong-turn")).status, 409);
		const aborting = abort(running.url, current.sessionId, first.turnId);
		await abortSeen.promise;
		const afterResponse = prompt(running.url, "after", current.sessionId);
		assert.equal(
			await Promise.race([afterResponse.then(() => "responded"), setImmediate().then(() => "waiting")]),
			"waiting",
		);
		assert.equal((await localFetch(`${running.url}/conversation/new`, { method: "POST" })).status, 409);
		cleanup.resolve();

		assert.equal((await aborting).status, 204);
		const after = await readJson<Protocol.MessageSubmittedEvent>((await afterResponse).body);
		assert.equal(after.queued, false);
		assert.notEqual(after.turnId, first.turnId);
		const firstEvents = (await readThroughEnd(frames, first.turnId)).map(({ event }) => event);
		assert.deepEqual(firstEvents.slice(-4), [
			aborted(first),
			undelivered(second, "aborted"),
			undelivered(third, "aborted"),
			end(first),
		]);
		assert.equal(state.sendCalls, 2);
		await frames.return?.(undefined);
	} finally {
		cleanup.resolve();
		await running.close();
	}
});

test("aborts before initial delivery and marks every submitted message undelivered", async () => {
	const authStarted = Promise.withResolvers<void>();
	const harness: Harness = {
		reset() {},
		async *send(input, signal) {
			authStarted.resolve();
			await waitForAbort(signal);
			yield aborted(input.initial);
			yield end(input.initial);
		},
	};
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		const first = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "first", current.sessionId)).body,
		);
		await authStarted.promise;
		const second = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "second", current.sessionId)).body,
		);

		assert.equal((await abort(running.url, current.sessionId, first.turnId)).status, 204);
		const turnEvents = (await readThroughEnd(frames, first.turnId)).map(({ event }) => event);
		assert.deepEqual(turnEvents.slice(-4), [
			aborted(first),
			undelivered(first, "aborted"),
			undelivered(second, "aborted"),
			end(first),
		]);
		assert(!turnEvents.some((event) => event.type === "message_delivered"));
		await frames.return?.(undefined);
	} finally {
		await running.close();
	}
});

test("marks the initial and queued messages undelivered when authentication fails before delivery", async () => {
	const authStarted = Promise.withResolvers<void>();
	const fail = Promise.withResolvers<void>();
	const harness: Harness = {
		reset() {},
		async *send(input) {
			authStarted.resolve();
			await fail.promise;
			yield error(input.initial, "not logged in");
			yield end(input.initial);
		},
	};
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		const first = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "first", current.sessionId)).body,
		);
		await authStarted.promise;
		const second = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "second", current.sessionId)).body,
		);
		fail.resolve();

		const turnEvents = (await readThroughEnd(frames, first.turnId)).map(({ event }) => event);
		assert.deepEqual(turnEvents.slice(-4), [
			error(first, "not logged in"),
			undelivered(first, "error"),
			undelivered(second, "error"),
			end(first),
		]);
		await frames.return?.(undefined);
	} finally {
		fail.resolve();
		await running.close();
	}
});

test("preserves delivered history and marks only pending steering undelivered on provider failure", async () => {
	const providerStarted = Promise.withResolvers<void>();
	const fail = Promise.withResolvers<void>();
	const harness: Harness = {
		reset() {},
		async *send(input) {
			yield delivered(input.initial);
			providerStarted.resolve();
			await fail.promise;
			yield error(input.initial, "provider failed");
			yield end(input.initial);
		},
	};
	const running = await startServer(harness);
	try {
		const events = await localFetch(`${running.url}/event`);
		assert(events.body);
		const frames = readFrames(events.body)[Symbol.asyncIterator]();
		const current = await health(running.url);
		const first = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "first", current.sessionId)).body,
		);
		await providerStarted.promise;
		const second = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "second", current.sessionId)).body,
		);
		fail.resolve();

		const turnEvents = (await readThroughEnd(frames, first.turnId)).map(({ event }) => event);
		assert(turnEvents.some((event) => event.type === "message_delivered" && event.messageId === first.messageId));
		assert(!turnEvents.some((event) => event.type === "message_undelivered" && event.messageId === first.messageId));
		assert.deepEqual(turnEvents.slice(-3), [error(first, "provider failed"), undelivered(second, "error"), end(first)]);
		await frames.return?.(undefined);
	} finally {
		fail.resolve();
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

test("unexpected harness failures still emit error and end", async () => {
	const harness: Harness = {
		reset() {},
		send() {
			return {
				[Symbol.asyncIterator]: () => ({
					next: async (): Promise<IteratorResult<Protocol.TurnEvent>> => {
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
		const first = await readJson<Protocol.MessageSubmittedEvent>(
			(await prompt(running.url, "fail", current.sessionId)).body,
		);
		const turnEvents = (await readThroughEnd(frames, first.turnId)).map(({ event }) => event);

		assert.deepEqual(turnEvents.slice(-3), [error(first, "pump failed"), undelivered(first, "error"), end(first)]);
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
			async *send(input) {
				for (let message: Engine.UserMessage | undefined = input.initial; message; message = input.takeSteering(true)) {
					state.prompts.push(message.text);
					yield delivered(message);
					yield delta(message, message.text);
				}
				state.finished.resolve();
				yield end(input.initial);
			},
		},
	};
}

function delivered(message: Engine.UserMessage | Protocol.MessageSubmittedEvent): Protocol.MessageDeliveredEvent {
	return {
		actor: "human",
		modelRole: "user",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "message_delivered",
		messageId: message.messageId,
		text: message.text,
	};
}

function delta(message: Engine.UserMessage, text: string): Protocol.MessageDeltaEvent {
	return {
		actor: "agent",
		modelRole: "assistant",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "message_delta",
		text,
	};
}

function toolCall(message: Engine.UserMessage, id: string, name: string): Protocol.ToolCallEvent {
	return {
		actor: "agent",
		modelRole: "assistant",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "tool_call",
		id,
		name,
		arguments: "{}",
	};
}

function toolResult(message: Engine.UserMessage, id: string, name: string): Protocol.ToolResultEvent {
	return {
		actor: "process",
		modelRole: "tool",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "tool_result",
		id,
		name,
		status: "ok",
		output: `${name} result`,
	};
}

function error(message: Engine.UserMessage | Protocol.MessageSubmittedEvent, text: string): Protocol.ErrorEvent {
	return {
		actor: "process",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "error",
		message: text,
	};
}

function aborted(message: Engine.UserMessage | Protocol.MessageSubmittedEvent): Protocol.AbortedEvent {
	return {
		actor: "process",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "aborted",
	};
}

function undelivered(
	message: Engine.UserMessage | Protocol.MessageSubmittedEvent,
	reason: "aborted" | "error",
): Protocol.MessageUndeliveredEvent {
	return {
		actor: "process",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "message_undelivered",
		messageId: message.messageId,
		text: message.text,
		reason,
	};
}

function end(message: Engine.UserMessage | Protocol.MessageSubmittedEvent): Protocol.EndEvent {
	return {
		actor: "process",
		sessionId: message.sessionId,
		turnId: message.turnId,
		type: "end",
	};
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
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

async function readThroughEnd(
	frames: AsyncIterator<string>,
	turnId: string,
): Promise<Array<{ id: number; event: Protocol.TurnEvent }>> {
	const events: Array<{ id: number; event: Protocol.TurnEvent }> = [];
	while (true) {
		const frame = parseFrame(await nextFrame(frames));
		if (!("turnId" in frame.event) || frame.event.turnId !== turnId) continue;
		events.push({ id: frame.id, event: frame.event });
		if (frame.event.type === "end") return events;
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
