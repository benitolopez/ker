import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createClient } from "@ker-ai/client";
import type * as Engine from "@ker-ai/engine";
import { runNode, Spool } from "@ker-ai/node";
import type * as Protocol from "@ker-ai/protocol";
import { NODE_PROTOCOL_VERSION, type PlaneToNodeFrame } from "@ker-ai/protocol/node";
import { createServer } from "@ker-ai/server";
import { STORE_VERSION, type StoredRecord } from "@ker-ai/store";

test("enrolls a remote node and runs a session through the socket", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-socket-"));
	const server = createServer({ sessionDir: join(root, "sessions"), catalogPath: join(root, "catalog.db") });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
	const client = createClient({ baseUrl });
	const enrollment = await client.createEnrollment();
	if (!enrollment.ok) throw new Error(enrollment.error.code);
	assert.equal(enrollment.ok, true);
	const nodePath = join(root, "node.json");
	const running = await runNode({
		serverUrl: baseUrl,
		token: enrollment.value.token,
		nodePath,
		spoolDir: join(root, "spool"),
		harnessFactory: immediateFactory,
		definition: () => ({
			systemPrompt: "System prompt",
			tools: [],
			compaction: {
				systemPrompt: "Summary system prompt",
				initialInstructions: "Initial instructions",
				updateInstructions: "Update instructions",
			},
		}),
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	t.after(async () => {
		await running.shutdown();
		await server.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(root, { recursive: true, force: true });
	});
	const nodes = await client.listNodes();
	assert.equal(nodes.ok && nodes.value.nodes[0]?.connected, true);
	const created = await client.createSession(root);
	if (!created.ok) throw new Error(created.error.code);
	assert.equal(created.ok, true);
	const admitted = await client.prompt(created.value.id, "hello");
	assert.equal(admitted.ok, true);
	await waitForAnswerText(client, created.value.id, "answer");
	assert.match(await readFile(nodePath, "utf8"), /"server"/);
});

test("a revoked stored credential rejects once without retrying", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-socket-revoked-"));
	const server = createServer({ sessionDir: join(root, "sessions"), catalogPath: join(root, "catalog.db") });
	const port = await listenServer(server);
	const baseUrl = `http://127.0.0.1:${port}`;
	const client = createClient({ baseUrl });
	const enrollment = await client.createEnrollment();
	if (!enrollment.ok) throw new Error(enrollment.error.code);
	const nodePath = join(root, "node.json");
	const spoolDir = join(root, "spool");
	const running = await runNode({ serverUrl: baseUrl, token: enrollment.value.token, nodePath, spoolDir });
	t.after(async () => {
		await running.shutdown();
		await stopServer(server);
		await rm(root, { recursive: true, force: true });
	});
	const nodes = await client.listNodes();
	if (!nodes.ok || !nodes.value.nodes[0]) throw new Error("Enrolled node was not listed");
	await running.shutdown();
	const revoked = await client.revokeNode(nodes.value.nodes[0].id);
	if (!revoked.ok) throw new Error(revoked.error.code);

	const statuses: string[] = [];
	await assert.rejects(
		runNode({
			nodePath,
			spoolDir,
			onStatus: (message) => {
				statuses.push(message);
			},
		}),
		/Node credentials were refused/,
	);
	await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
	assert.deepEqual(
		statuses.filter((message) => message.startsWith("node connection refused")),
		["node connection refused: Node credentials were refused"],
	);
	assert.equal(
		statuses.some((message) => message.startsWith("node frame failed")),
		false,
	);
	assert.equal(
		statuses.some((message) => message.startsWith("node connection lost")),
		false,
	);
});

test("drops a stale spool for an unknown session and reconnects", { timeout: 5_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-socket-stale-spool-"));
	const server = createServer({ sessionDir: join(root, "sessions"), catalogPath: join(root, "catalog.db") });
	const active: { running?: Awaited<ReturnType<typeof runNode>> } = {};
	t.after(async () => {
		await active.running?.shutdown();
		await stopServer(server);
		await rm(root, { recursive: true, force: true });
	});
	const port = await listenServer(server);
	const baseUrl = `http://127.0.0.1:${port}`;
	const client = createClient({ baseUrl });
	const enrollment = await client.createEnrollment();
	if (!enrollment.ok) throw new Error(enrollment.error.code);
	const spoolDir = join(root, "spool");
	const staleSessionId = "00000000-0000-4000-8000-000000000030";
	const spool = new Spool(spoolDir);
	await spool.open(staleSessionId, "record-lost-with-server-data");
	await spool.append(staleSessionId, [{ type: "stats", contextTokens: 42, model: null }]);
	const spoolPath = join(spoolDir, `${staleSessionId}.jsonl`);
	assert.equal(existsSync(spoolPath), true);
	const statuses: string[] = [];
	active.running = await runNode({
		serverUrl: baseUrl,
		token: enrollment.value.token,
		nodePath: join(root, "node.json"),
		spoolDir,
		onStatus: (message) => {
			statuses.push(message);
		},
	});

	assert.equal(existsSync(spoolPath), false);
	assert.equal(
		statuses.some((message) => message === `record chain rejected for session ${staleSessionId}`),
		true,
	);
	const nodes = await client.listNodes();
	assert.equal(nodes.ok && nodes.value.nodes[0]?.connected, true);
});

test("replays a running turn from the spool after the server restarts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-socket-restart-"));
	const sessionDir = join(root, "sessions");
	const catalogPath = join(root, "catalog.db");
	const spoolDir = join(root, "spool");
	const firstServer = createServer({ sessionDir, catalogPath });
	const port = await listenServer(firstServer);
	const baseUrl = `http://127.0.0.1:${port}`;
	const client = createClient({ baseUrl });
	const enrollment = await client.createEnrollment();
	if (!enrollment.ok) throw new Error(enrollment.error.code);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const lost = Promise.withResolvers<void>();
	const reconnected = Promise.withResolvers<void>();
	const connection = { count: 0 };
	const running = await runNode({
		serverUrl: baseUrl,
		token: enrollment.value.token,
		nodePath: join(root, "node.json"),
		spoolDir,
		harnessFactory: (initial) => {
			const state = structuredClone(initial);
			return {
				snapshot: () => structuredClone(state),
				async *compact(): AsyncGenerator<Protocol.TurnEvent, Engine.CompactionOutcome> {
					yield* [];
					return { kind: "skipped", reason: "nothing_to_compact" };
				},
				async *send(input) {
					state.messages.push({ role: "user", content: input.text });
					yield {
						actor: "human" as const,
						modelRole: "user" as const,
						sessionId: input.sessionId,
						turnId: input.turnId,
						type: "message_delivered" as const,
						messageId: input.messageId,
						text: input.text,
					};
					started.resolve();
					await release.promise;
					const messageId = "restart-answer";
					yield {
						actor: "agent" as const,
						modelRole: "assistant" as const,
						sessionId: input.sessionId,
						turnId: input.turnId,
						type: "message_delta" as const,
						messageId,
						offset: 0,
						text: "after restart",
					};
					state.messages.push({ role: "assistant", content: "after restart", toolCalls: [], reasoning: [] });
					yield {
						actor: "agent" as const,
						modelRole: "assistant" as const,
						sessionId: input.sessionId,
						turnId: input.turnId,
						type: "assistant_message_completed" as const,
						messageId,
						reason: "completed" as const,
					};
					yield { actor: "process" as const, sessionId: input.sessionId, turnId: input.turnId, type: "end" as const };
				},
			};
		},
		definition: () => ({
			systemPrompt: "System prompt",
			tools: [],
			compaction: {
				systemPrompt: "Summary system prompt",
				initialInstructions: "Initial instructions",
				updateInstructions: "Update instructions",
			},
		}),
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
		onStatus: (message) => {
			if (message.startsWith("node connection lost")) lost.resolve();
			if (!message.startsWith("node connected")) return;
			connection.count++;
			if (connection.count === 2) reconnected.resolve();
		},
	});
	const active = { server: firstServer };
	t.after(async () => {
		await running.shutdown();
		await stopServer(active.server);
		await rm(root, { recursive: true, force: true });
	});
	const created = await client.createSession(root);
	if (!created.ok) throw new Error(created.error.code);
	const admitted = await client.prompt(created.value.id, "keep going");
	if (!admitted.ok) throw new Error(admitted.error.code);
	await started.promise;
	await stopServer(firstServer);
	await lost.promise;
	release.resolve();
	const spoolPath = join(spoolDir, `${created.value.id}.jsonl`);
	for (let attempt = 0; attempt < 100 && !existsSync(spoolPath); attempt++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(existsSync(spoolPath), true);

	const restarted = createServer({ sessionDir, catalogPath });
	active.server = restarted;
	await listenServer(restarted, port);
	await reconnected.promise;
	await waitForAnswerText(client, created.value.id, "after restart");
	assert.equal(existsSync(spoolPath), false);
});

test("the node socket refuses invalid credentials, spent tokens, revoked nodes, and wrong versions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-socket-auth-"));
	const catalogPath = join(root, "catalog.db");
	const server = createServer({ sessionDir: join(root, "sessions"), catalogPath });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
	const client = createClient({ baseUrl });
	t.after(async () => {
		await server.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(root, { recursive: true, force: true });
	});

	const invalid = await openSocket(baseUrl);
	const invalidRefusal = await exchange(invalid, {
		type: "enroll",
		token: "invalid",
		identity: identity("00000000-0000-4000-8000-000000000010"),
	});
	assert.equal(invalidRefusal.type, "refused");
	if (invalidRefusal.type === "refused") assert.equal(invalidRefusal.code, "unauthorized");
	await socketClosed(invalid);

	const expiredEnrollment = await client.createEnrollment();
	if (!expiredEnrollment.ok) throw new Error(expiredEnrollment.error.code);
	const database = new DatabaseSync(catalogPath);
	database.prepare("UPDATE one_time_token SET expires_at = ? WHERE used_at IS NULL").run("2020-01-01T00:00:00.000Z");
	database.close();
	const expired = await openSocket(baseUrl);
	const expiredRefusal = await exchange(expired, {
		type: "enroll",
		token: expiredEnrollment.value.token,
		identity: identity("00000000-0000-4000-8000-000000000011"),
	});
	assert.equal(expiredRefusal.type, "refused");
	if (expiredRefusal.type === "refused") assert.equal(expiredRefusal.code, "token_expired");
	await socketClosed(expired);

	const enrollment = await client.createEnrollment();
	if (!enrollment.ok) throw new Error(enrollment.error.code);
	const nodeId = "00000000-0000-4000-8000-000000000012";
	const enrolled = await openSocket(baseUrl);
	const welcome = await exchange(enrolled, {
		type: "enroll",
		token: enrollment.value.token,
		identity: identity(nodeId),
	});
	assert.equal(welcome.type, "welcome");
	if (welcome.type !== "welcome" || !welcome.secret) throw new Error("Enrollment did not return a secret");
	const secret = welcome.secret;
	const ready = nextFrame(enrolled);
	enrolled.send(
		JSON.stringify({ type: "hello", nodeProtocol: NODE_PROTOCOL_VERSION, storeVersion: STORE_VERSION, running: [] }),
	);
	enrolled.send(JSON.stringify({ type: "drained" }));
	assert.equal((await ready).type, "ready");
	const descriptor: Protocol.SessionDescriptor = {
		id: "00000000-0000-4000-8000-000000000020",
		nodeId,
		cwd: root,
		projectRoot: root,
		createdAt: "2026-09-08T00:00:00.000Z",
		updatedAt: "2026-09-08T00:00:01.000Z",
	};
	const records: StoredRecord[] = [
		{
			version: STORE_VERSION,
			recordId: "record-session",
			previousRecordId: null,
			at: descriptor.createdAt,
			type: "session",
			session: descriptor,
		},
		{
			version: STORE_VERSION,
			recordId: "record-definition",
			previousRecordId: "record-session",
			at: descriptor.updatedAt,
			type: "definition",
			systemPrompt: "System prompt",
			tools: [],
			compaction: {
				systemPrompt: "Summary system prompt",
				initialInstructions: "Initial instructions",
				updateInstructions: "Update instructions",
			},
		},
	];
	const creating = client.createSession(root, nodeId);
	const createCall = await nextFrame(enrolled);
	assert.equal(createCall.type, "call");
	if (createCall.type !== "call") throw new Error("Expected createSession call");
	assert.equal(createCall.method, "createSession");
	assert.equal((await exchange(enrolled, { type: "records", sessionId: descriptor.id, records })).type, "ack");
	enrolled.send(JSON.stringify({ type: "result", id: createCall.id, value: descriptor }));
	const gitCall = await nextFrame(enrolled);
	assert.equal(gitCall.type, "call");
	if (gitCall.type !== "call") throw new Error("Expected observeGitRemote call");
	assert.equal(gitCall.method, "observeGitRemote");
	enrolled.send(JSON.stringify({ type: "result", id: gitCall.id, value: null }));
	assert.equal((await creating).ok, true);

	const foreignEnrollment = await client.createEnrollment();
	if (!foreignEnrollment.ok) throw new Error(foreignEnrollment.error.code);
	const foreignNodeId = "00000000-0000-4000-8000-000000000015";
	const foreign = await openSocket(baseUrl);
	assert.equal(
		(
			await exchange(foreign, {
				type: "enroll",
				token: foreignEnrollment.value.token,
				identity: identity(foreignNodeId),
			})
		).type,
		"welcome",
	);
	const foreignReady = nextFrame(foreign);
	foreign.send(
		JSON.stringify({ type: "hello", nodeProtocol: NODE_PROTOCOL_VERSION, storeVersion: STORE_VERSION, running: [] }),
	);
	foreign.send(JSON.stringify({ type: "drained" }));
	assert.equal((await foreignReady).type, "ready");
	const foreignClosed = socketClosed(foreign);
	foreign.send(
		JSON.stringify({
			type: "records",
			sessionId: descriptor.id,
			records: [
				{
					version: STORE_VERSION,
					recordId: "foreign-session",
					previousRecordId: null,
					at: "2026-09-08T00:00:02.000Z",
					type: "session",
					session: {
						...descriptor,
						id: "00000000-0000-4000-8000-000000000021",
						nodeId: foreignNodeId,
					},
				},
			],
		}),
	);
	await foreignClosed;
	assert.equal((await client.snapshot(descriptor.id)).ok, true);

	const rejected = await exchange(enrolled, {
		type: "records",
		sessionId: descriptor.id,
		records: [
			{
				version: STORE_VERSION,
				recordId: "record-fork",
				previousRecordId: "not-the-tail",
				at: "2026-09-08T00:00:02.000Z",
				type: "stats",
				contextTokens: 0,
				model: null,
			},
		],
	});
	assert.equal(rejected.type, "reject");
	const listed = await client.listSessions({ all: true });
	assert.equal(listed.ok, true);
	if (listed.ok)
		assert.equal(listed.value.sessions.find((session) => session.id === descriptor.id)?.status, "unreadable");

	const reused = await openSocket(baseUrl);
	const reusedRefusal = await exchange(reused, {
		type: "enroll",
		token: enrollment.value.token,
		identity: identity("00000000-0000-4000-8000-000000000013"),
	});
	assert.equal(reusedRefusal.type, "refused");
	if (reusedRefusal.type === "refused") assert.equal(reusedRefusal.code, "token_used");
	await socketClosed(reused);

	const wrongSecret = await openSocket(baseUrl);
	const secretRefusal = await exchange(wrongSecret, { type: "auth", nodeId, secret: "wrong" });
	assert.equal(secretRefusal.type, "refused");
	if (secretRefusal.type === "refused") assert.equal(secretRefusal.code, "unauthorized");
	await socketClosed(wrongSecret);

	const versionEnrollment = await client.createEnrollment();
	if (!versionEnrollment.ok) throw new Error(versionEnrollment.error.code);
	const wrongVersion = await openSocket(baseUrl);
	assert.equal(
		(
			await exchange(wrongVersion, {
				type: "enroll",
				token: versionEnrollment.value.token,
				identity: identity("00000000-0000-4000-8000-000000000014"),
			})
		).type,
		"welcome",
	);
	const versionRefusal = await exchange(wrongVersion, {
		type: "hello",
		nodeProtocol: "wrong",
		storeVersion: STORE_VERSION,
		running: [],
	});
	assert.equal(versionRefusal.type, "refused");
	if (versionRefusal.type === "refused") assert.equal(versionRefusal.code, "version_mismatch");
	await socketClosed(wrongVersion);

	const disconnected = socketClosed(enrolled);
	const revoked = await client.revokeNode(nodeId);
	assert.equal(revoked.ok, true);
	await disconnected;
	const afterRevoke = await openSocket(baseUrl);
	const revokedRefusal = await exchange(afterRevoke, { type: "auth", nodeId, secret });
	assert.equal(revokedRefusal.type, "refused");
	if (revokedRefusal.type === "refused") assert.equal(revokedRefusal.code, "revoked");
	await socketClosed(afterRevoke);
});

function immediateFactory(initial: Engine.HarnessState) {
	const state = structuredClone(initial);
	return {
		snapshot: () => structuredClone(state),
		async *compact(): AsyncGenerator<Protocol.TurnEvent, Engine.CompactionOutcome> {
			yield* [];
			return { kind: "skipped" as const, reason: "nothing_to_compact" as const };
		},
		async *send(input: Engine.UserMessage) {
			state.messages.push({ role: "user", content: input.text });
			yield {
				actor: "human" as const,
				modelRole: "user" as const,
				sessionId: input.sessionId,
				turnId: input.turnId,
				type: "message_delivered" as const,
				messageId: input.messageId,
				text: input.text,
			};
			const messageId = "answer-1";
			yield {
				actor: "agent" as const,
				modelRole: "assistant" as const,
				sessionId: input.sessionId,
				turnId: input.turnId,
				type: "message_delta" as const,
				messageId,
				offset: 0,
				text: "answer",
			};
			state.messages.push({ role: "assistant", content: "answer", toolCalls: [], reasoning: [] });
			yield {
				actor: "agent" as const,
				modelRole: "assistant" as const,
				sessionId: input.sessionId,
				turnId: input.turnId,
				type: "assistant_message_completed" as const,
				messageId,
				reason: "completed" as const,
			};
			yield { actor: "process" as const, sessionId: input.sessionId, turnId: input.turnId, type: "end" as const };
		},
	};
}

async function waitForAnswerText(
	client: ReturnType<typeof createClient>,
	sessionId: Protocol.SessionId,
	text: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const snapshot = await client.snapshot(sessionId);
		if (!snapshot.ok) throw new Error(snapshot.error.message ?? snapshot.error.code);
		if (snapshot.value.messages.some((message) => message.text === text) && !snapshot.value.queue.running) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Remote answer did not reach the plane");
}

async function listenServer(server: ReturnType<typeof createServer>, port = 0): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
	return (address as AddressInfo).port;
}

async function stopServer(server: ReturnType<typeof createServer>): Promise<void> {
	if (!server.listening) return;
	await server.shutdown();
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function identity(id: string) {
	return { id, name: `node-${id.slice(-2)}`, createdAt: "2026-09-08T00:00:00.000Z" };
}

function openSocket(baseUrl: string): Promise<WebSocket> {
	const url = new URL(baseUrl);
	url.protocol = "ws:";
	url.pathname = "/nodes/socket";
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.addEventListener("open", () => resolve(socket), { once: true });
		socket.addEventListener("error", () => reject(new Error("Socket connection failed")), { once: true });
	});
}

async function exchange(socket: WebSocket, frame: object): Promise<PlaneToNodeFrame> {
	const response = nextFrame(socket);
	socket.send(JSON.stringify(frame));
	return response;
}

function nextFrame(socket: WebSocket): Promise<PlaneToNodeFrame> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for a socket frame")), 2_000);
		socket.addEventListener(
			"message",
			(event) => {
				clearTimeout(timer);
				if (typeof event.data !== "string") {
					reject(new Error("Expected a text socket frame"));
					return;
				}
				resolve(JSON.parse(event.data) as PlaneToNodeFrame);
			},
			{ once: true },
		);
	});
}

function socketClosed(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for the socket to close")), 2_000);
		socket.addEventListener(
			"close",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
