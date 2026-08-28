import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import * as Protocol from "@ker-ai/protocol";
import { type RouteDefinition, type RouteKey, routes } from "@ker-ai/protocol/routes";
import { Value } from "@sinclair/typebox/value";
import { createDaemon, type DaemonOptions } from "../src/index.ts";

const LOCAL_HOST = `127.0.0.1:${Protocol.DEFAULT_PORT}`;

test("daemon responses conform to the route table", async (t) => {
	const running = await startServer(t);
	await assertJson("health", await localFetch(`${running.url}/health`), 200);
	await assertJson("openapi", await localFetch(`${running.url}/openapi.json`), 200);

	const session = await assertJson<Protocol.SessionDescriptor>(
		"createSession",
		await localFetch(`${running.url}/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: process.cwd() } satisfies Protocol.CreateSessionRequest),
		}),
		201,
	);
	await assertJson(
		"listSessions",
		await localFetch(`${running.url}/sessions?cwd=${encodeURIComponent(process.cwd())}`),
		200,
	);
	const snapshot = await assertJson<Protocol.SessionSnapshot>(
		"snapshot",
		await localFetch(`${running.url}/sessions/${session.id}`),
		200,
	);

	const stream = await localFetch(
		`${running.url}/sessions/${session.id}/events?epoch=${snapshot.cursor.epoch}&sequence=${snapshot.cursor.sequence}`,
	);
	assert.equal(stream.status, 200);
	const admitted = await assertJson<Protocol.PromptAdmission>(
		"prompt",
		await localFetch(`${running.url}/sessions/${session.id}/prompts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "hello" } satisfies Protocol.PromptRequest),
		}),
		202,
	);
	const eventTypes: Protocol.Event["type"][] = [];
	for await (const envelope of readEnvelopes(stream.body)) {
		assert(Value.Check(routes.events.responses[200], envelope));
		if (!("turnId" in envelope.event) || envelope.event.turnId !== admitted.turnId) continue;
		eventTypes.push(envelope.event.type);
		if (envelope.event.type === "end") break;
	}
	assert(eventTypes.includes("message_delta"));
	assert.equal(eventTypes.at(-1), "end");

	await assertJson(
		"compact",
		await localFetch(`${running.url}/sessions/${session.id}/compact`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}),
		202,
	);
	await assertJson(
		"cancel",
		await localFetch(`${running.url}/sessions/${session.id}/turns/missing/cancel`, { method: "POST" }),
		409,
	);

	await assertJson("events", await localFetch(`${running.url}/sessions/${session.id}/events?epoch=&sequence=bad`), 400);
	await assertJson("snapshot", await localFetch(`${running.url}/sessions/missing`), 404);
	await assertJson(
		"prompt",
		await localFetch(`${running.url}/sessions/${session.id}/prompts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: " " }),
		}),
		400,
	);
	const unknown = await localFetch(`${running.url}/missing`);
	assert.equal(unknown.status, 404);
	assert(Value.Check(Protocol.ErrorBody, await readJson(unknown.body)));
});

async function assertJson<T = unknown>(key: RouteKey, response: TestResponse, status: number): Promise<T> {
	assert.equal(response.status, status);
	const value = await readJson<T>(response.body);
	const schema = (routes[key] as RouteDefinition).responses[status];
	assert(schema, `Route ${key} does not declare status ${status}`);
	assert(Value.Check(schema, value), `${key} response ${status} does not match its schema`);
	return value;
}

async function startServer(t: TestContext): Promise<{ url: string }> {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-daemon-contract-"));
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
				yield {
					actor: "human",
					modelRole: "user",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "message_delivered",
					messageId: input.messageId,
					text: input.text,
				};
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

interface TestResponse {
	status: number;
	body: IncomingMessage;
}

function localFetch(
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<TestResponse> {
	return new Promise((resolve, reject) => {
		const req = request(url, { method: init?.method, headers: { ...init?.headers, host: LOCAL_HOST } }, (res) =>
			resolve({ status: res.statusCode ?? 0, body: res }),
		);
		req.on("error", reject);
		req.end(init?.body);
	});
}

async function readJson<T>(body: AsyncIterable<Uint8Array>): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of body) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function* readEnvelopes(body: AsyncIterable<Uint8Array>): AsyncGenerator<Protocol.EventEnvelope> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const data = frame.match(/^data: (.+)$/m)?.[1];
			if (data) yield JSON.parse(data) as Protocol.EventEnvelope;
		}
	}
}
