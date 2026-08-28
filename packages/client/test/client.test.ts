import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type TestContext, test } from "node:test";
import { createDaemon, type DaemonOptions } from "@ker-ai/daemon";
import type * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker-ai/protocol";
import { createClient } from "../src/index.ts";

test("the client calls every route and parses a streamed turn", async (t) => {
	const running = await startServer(t);
	t.mock.method(globalThis, "fetch", localFetch);
	const client = createClient({ baseUrl: running.url });

	const health = await client.health();
	assert(health.ok);
	assert.deepEqual(health.value, { name: "ker", protocol: PROTOCOL_VERSION });

	const document = await client.openapi();
	assert(document.ok);
	assert.equal(document.value.openapi, "3.1.0");

	const created = await client.createSession(process.cwd());
	assert(created.ok);
	const session = created.value;

	const listed = await client.listSessions({ cwd: process.cwd() });
	assert(listed.ok);
	assert.deepEqual(
		listed.value.sessions.map((candidate) => candidate.id),
		[session.id],
	);

	const snapshot = await client.snapshot(session.id);
	assert(snapshot.ok);
	const subscription = await client.subscribe(session.id, snapshot.value.cursor);
	assert.equal(subscription.kind, "stream");
	if (subscription.kind !== "stream") throw new Error("Expected an event stream");

	const admitted = await client.prompt(session.id, "hello");
	assert(admitted.ok);
	const observed: Protocol.Event["type"][] = [];
	for await (const envelope of subscription.envelopes) {
		if (!("turnId" in envelope.event) || envelope.event.turnId !== admitted.value.turnId) continue;
		observed.push(envelope.event.type);
		if (envelope.event.type === "end") break;
	}
	assert(observed.includes("message_delta"));
	assert.equal(observed.at(-1), "end");

	const compacted = await client.compact(session.id, "preserve decisions");
	assert(compacted.ok);
	assert.equal(compacted.status, 202);

	const unavailable = await client.cancel(session.id, "missing-turn");
	assert.equal(unavailable.ok, false);
	if (!unavailable.ok) {
		assert.equal(unavailable.status, 409);
		assert.equal(unavailable.error.code, "turn_unavailable");
	}

	const missing = await client.snapshot("missing-session");
	assert.equal(missing.ok, false);
	if (!missing.ok) {
		assert.equal(missing.status, 404);
		assert.equal(missing.error.code, "session_not_found");
	}

	const missingStream = await client.subscribe("missing-session", { epoch: "missing", sequence: 0 });
	assert.equal(missingStream.kind, "error");
	if (missingStream.kind === "error") {
		assert.equal(missingStream.status, 404);
		assert.equal(missingStream.error.code, "session_not_found");
	}
});

test("the client passes abort signals through and leaves network errors untouched", async (t) => {
	const controller = new AbortController();
	const failure = new TypeError("network failed");
	t.mock.method(globalThis, "fetch", async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
		assert.equal(init?.signal, controller.signal);
		throw failure;
	});
	await assert.rejects(createClient().health(controller.signal), (error) => error === failure);
});

async function startServer(t: TestContext): Promise<{ url: string }> {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-client-"));
	const server = createDaemon({
		sessionDir,
		catalogPath: join(sessionDir, "catalog.db"),
		nodePath: join(sessionDir, "node.json"),
		harnessFactory: immediateFactory(),
		definition: () => ({
			systemPrompt: "System prompt",
			tools: [],
			compaction: {
				systemPrompt: "Summary system prompt",
				initialInstructions: "Initial instructions",
				updateInstructions: "Update instructions",
			},
		}),
		recoveryWindowMinutes: Number.MAX_SAFE_INTEGER,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	t.after(async () => {
		await server.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(sessionDir, { recursive: true, force: true });
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	return { url: `http://127.0.0.1:${(address as AddressInfo).port}` };
}

function immediateFactory(): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			async *compact() {
				yield* [];
				return { kind: "skipped", reason: "nothing_to_compact" };
			},
			async *send(input) {
				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				const messageId = randomUUID();
				const text = `answer:${input.text}`;
				yield {
					actor: "agent",
					modelRole: "assistant",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "message_delta",
					messageId,
					offset: 0,
					text,
				};
				state.messages.push({ role: "assistant", content: text, toolCalls: [], reasoning: [] });
				yield {
					actor: "agent",
					modelRole: "assistant",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "assistant_message_completed",
					messageId,
					reason: "completed",
				};
				yield { actor: "process", sessionId: input.sessionId, turnId: input.turnId, type: "end" };
			},
		};
	};
}

function delivered(input: Engine.UserMessage): Protocol.MessageDeliveredEvent {
	return {
		actor: "human",
		modelRole: "user",
		sessionId: input.sessionId,
		turnId: input.turnId,
		type: "message_delivered",
		messageId: input.messageId,
		text: input.text,
	};
}

function localFetch(input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : input);
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
	headers.set("host", `127.0.0.1:${DEFAULT_PORT}`);
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: init?.method ?? (input instanceof Request ? input.method : "GET"),
				headers: Object.fromEntries(headers),
			},
			(res) => {
				const responseHeaders = new Headers();
				for (const [name, value] of Object.entries(res.headers)) {
					if (Array.isArray(value)) {
						for (const item of value) responseHeaders.append(name, item);
						continue;
					}
					if (value !== undefined) responseHeaders.set(name, value);
				}
				resolve(
					new Response(Readable.toWeb(res), {
						status: res.statusCode,
						headers: responseHeaders,
					}),
				);
			},
		);
		req.once("error", reject);
		if (typeof init?.body === "string" || init?.body instanceof Uint8Array) {
			req.end(init.body);
			return;
		}
		req.end();
	});
}
