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
import { AttachError, attach, type Client, createClient } from "../src/index.ts";

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
	const projects = await client.listProjects();
	assert(projects.ok);
	assert.equal(projects.value.projects.length, 1);
	const projectId = projects.value.projects[0]?.id ?? "missing";
	const project = await client.getProject(projectId);
	assert(project.ok);
	assert.deepEqual(project.value, projects.value.projects[0]);
	const projectSessions = await client.listProjectSessions(projectId);
	assert(projectSessions.ok);
	assert.deepEqual(
		projectSessions.value.sessions.map((candidate) => candidate.id),
		[session.id],
	);

	const listed = await client.listSessions({ cwd: process.cwd() });
	assert(listed.ok);
	assert.deepEqual(
		listed.value.sessions.map((candidate) => candidate.id),
		[session.id],
	);
	const createdForProject = await client.createProjectSession(projectId);
	assert(createdForProject.ok);
	assert.equal(createdForProject.value.projectId, projectId);
	const missingProject = await client.createProjectSession("missing");
	assert.equal(missingProject.ok, false);
	if (!missingProject.ok) {
		assert.equal(missingProject.status, 404);
		assert.equal(missingProject.error.code, "project_not_found");
	}
	const emptyDocuments = await client.listDocuments(projectId);
	assert(emptyDocuments.ok);
	assert.deepEqual(emptyDocuments.value.documents, []);
	const createdDocument = await client.createDocument(projectId, { title: "Notes", body: "Original" });
	assert(createdDocument.ok);
	const listedDocuments = await client.listDocuments(projectId);
	assert(listedDocuments.ok);
	assert.deepEqual(
		listedDocuments.value.documents.map((candidate) => candidate.id),
		[createdDocument.value.id],
	);
	const readDocument = await client.getDocument(createdDocument.value.id);
	assert(readDocument.ok);
	assert.deepEqual(readDocument.value, createdDocument.value);
	const updatedDocument = await client.updateDocument(createdDocument.value.id, {
		title: "Updated notes",
		body: "Replacement",
	});
	assert(updatedDocument.ok);
	assert.equal(updatedDocument.value.title, "Updated notes");
	const deletedDocument = await client.deleteDocument(createdDocument.value.id);
	assert(deletedDocument.ok);
	assert.deepEqual(deletedDocument.value, updatedDocument.value);
	const missingDocument = await client.getDocument(createdDocument.value.id);
	assert.equal(missingDocument.ok, false);
	if (!missingDocument.ok) {
		assert.equal(missingDocument.status, 404);
		assert.equal(missingDocument.error.code, "document_not_found");
	}

	const snapshot = await client.snapshot(createdForProject.value.id);
	assert(snapshot.ok);
	const subscription = await client.subscribe(createdForProject.value.id, snapshot.value.cursor);
	assert.equal(subscription.kind, "stream");
	if (subscription.kind !== "stream") throw new Error("Expected an event stream");

	const admitted = await client.prompt(createdForProject.value.id, "hello");
	assert(admitted.ok);
	const observed: Protocol.Event["type"][] = [];
	for await (const envelope of subscription.envelopes) {
		if (!("turnId" in envelope.event) || envelope.event.turnId !== admitted.value.turnId) continue;
		observed.push(envelope.event.type);
		if (envelope.event.type === "end") break;
	}
	assert(observed.includes("message_delta"));
	assert.equal(observed.at(-1), "end");

	const compacted = await client.compact(createdForProject.value.id, "preserve decisions");
	assert(compacted.ok);
	assert.equal(compacted.status, 202);

	const unavailable = await client.cancel(createdForProject.value.id, "missing-turn");
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

test("attach yields a snapshot and a live streamed turn", async (t) => {
	const running = await startServer(t);
	t.mock.method(globalThis, "fetch", localFetch);
	const client = createClient({ baseUrl: running.url });
	const created = await client.createSession(process.cwd());
	assert(created.ok);
	const iterator = attach(client, created.value.id, { retryDelayMs: 0 });
	const initial = await iterator.next();
	assert.equal(initial.value?.kind, "snapshot");

	const admitted = await client.prompt(created.value.id, "follow me");
	assert(admitted.ok);
	const observed: Protocol.Event["type"][] = [];
	while (observed.at(-1) !== "end") {
		const next = await iterator.next();
		assert.equal(next.done, false);
		if (next.value.kind !== "event") continue;
		if (!("turnId" in next.value.envelope.event) || next.value.envelope.event.turnId !== admitted.value.turnId) {
			continue;
		}
		observed.push(next.value.envelope.event.type);
	}
	assert(observed.includes("message_delta"));
	await iterator.return(undefined);
});

test("attach resnapshots after resync and stream drops", async (t) => {
	const running = await startServer(t);
	t.mock.method(globalThis, "fetch", localFetch);
	const base = createClient({ baseUrl: running.url });
	const created = await base.createSession(process.cwd());
	assert(created.ok);
	let subscriptions = 0;
	let snapshots = 0;
	const client: Client = {
		...base,
		snapshot: async (id, signal) => {
			snapshots++;
			if (snapshots === 3) throw new TypeError("daemon restarting");
			return base.snapshot(id, signal);
		},
		subscribe: async (id, cursor, signal) => {
			subscriptions++;
			if (subscriptions === 1) return { kind: "resync" };
			if (subscriptions === 2) {
				return {
					kind: "stream",
					envelopes: (async function* () {
						yield* [];
					})(),
				};
			}
			return base.subscribe(id, cursor, signal);
		},
	};
	const iterator = attach(client, created.value.id, { retryDelayMs: 0 });
	assert.equal((await iterator.next()).value?.kind, "snapshot");
	assert.equal((await iterator.next()).value?.kind, "snapshot");
	assert.equal((await iterator.next()).value?.kind, "snapshot");
	assert.equal(subscriptions, 2);
	assert.equal(snapshots, 4);
	await iterator.return(undefined);
});

test("attach ends on abort and throws typed HTTP failures", async (t) => {
	const running = await startServer(t);
	t.mock.method(globalThis, "fetch", localFetch);
	const client = createClient({ baseUrl: running.url });
	const missing = attach(client, "missing", { retryDelayMs: 0 });
	await assert.rejects(missing.next(), (error) => {
		assert(error instanceof AttachError);
		assert.equal(error.status, 404);
		assert.equal(error.error.code, "session_not_found");
		return true;
	});

	const created = await client.createSession(process.cwd());
	assert(created.ok);
	const controller = new AbortController();
	const iterator = attach(client, created.value.id, { signal: controller.signal, retryDelayMs: 0 });
	assert.equal((await iterator.next()).value?.kind, "snapshot");
	const waiting = iterator.next();
	controller.abort();
	assert.equal((await waiting).done, true);
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

test("project session creation posts without a body or content type", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: string | URL | globalThis.Request, init?: RequestInit) => {
		assert.equal(String(input), "http://127.0.0.1:5537/projects/project%2Fone/sessions");
		assert.equal(init?.method, "POST");
		assert.equal(init?.body, undefined);
		assert.equal(init?.headers, undefined);
		return Response.json({});
	});
	const result = await createClient().createProjectSession("project/one");
	assert.equal(result.ok, true);
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
		const abort = () => req.destroy(new DOMException("This operation was aborted", "AbortError"));
		if (init?.signal?.aborted) abort();
		init?.signal?.addEventListener("abort", abort, { once: true });
		if (typeof init?.body === "string" || init?.body instanceof Uint8Array) {
			req.end(init.body);
			return;
		}
		req.end();
	});
}
