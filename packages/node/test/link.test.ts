import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NodeToPlaneFrame, PlaneToNodeFrame } from "@ker-ai/protocol/node";
import type { StoredRecord } from "@ker-ai/store";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { Link } from "../src/link.ts";
import { Node } from "../src/node.ts";

test("preserves pending spool records across ready and load boundaries", { timeout: 5_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-link-ready-"));
	const server = createServer();
	const sockets = new WebSocketServer({ server, path: "/nodes/socket" });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
	const identity = {
		id: "00000000-0000-4000-8000-000000000040",
		name: "ready-race-node",
		createdAt: "2026-09-08T00:00:00.000Z",
	};
	const spoolDir = join(root, "spool");
	const sessionIds = ["00000000-0000-4000-8000-000000000041", "00000000-0000-4000-8000-000000000042"];
	const link = new Link({
		serverUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
		token: "enrollment-token",
		identity,
		identityPath: join(root, "node.json"),
		spoolDir,
	});
	const node = new Node({
		plane: link,
		identity,
		harnessFactory: () => {
			throw new Error("The handshake test does not run a harness");
		},
		definition: () => {
			throw new Error("The handshake test does not load a definition");
		},
		recoveryWindowMinutes: Number.MAX_SAFE_INTEGER,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	link.attach(node);
	t.after(async () => {
		await link.shutdown();
		await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(root, { recursive: true, force: true });
	});

	const drained = Promise.withResolvers<WebSocket>();
	const held = {
		sessionId: undefined as string | undefined,
		frame: Promise.withResolvers<Extract<NodeToPlaneFrame, { type: "records" }>>(),
	};
	const canonical = new Map<string, StoredRecord[]>();
	const received: Array<Extract<NodeToPlaneFrame, { type: "records" }>> = [];
	sockets.on("connection", (socket) => {
		socket.on("error", () => undefined);
		socket.on("message", (data) => {
			const frame = JSON.parse(data.toString()) as NodeToPlaneFrame;
			if (frame.type === "enroll") {
				const welcome: PlaneToNodeFrame = { type: "welcome", nodeId: identity.id, secret: "node-secret" };
				socket.send(JSON.stringify(welcome));
				return;
			}
			if (frame.type === "drained") {
				drained.resolve(socket);
				return;
			}
			if (frame.type === "load") {
				const records = canonical.get(frame.sessionId) ?? [];
				if (records.length > 0) {
					const chunk: PlaneToNodeFrame = {
						type: "chunk",
						id: frame.id,
						text: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
					};
					socket.send(JSON.stringify(chunk));
				}
				const end: PlaneToNodeFrame = { type: "end", id: frame.id, found: true };
				socket.send(JSON.stringify(end));
				return;
			}
			if (frame.type !== "records") return;
			received.push(frame);
			if (frame.sessionId === held.sessionId) {
				held.frame.resolve(frame);
				return;
			}
			const recordId = frame.records.at(-1)?.recordId;
			if (!recordId) throw new Error("Records frame was empty");
			canonical.set(frame.sessionId, [...(canonical.get(frame.sessionId) ?? []), ...(frame.records as StoredRecord[])]);
			const ack: PlaneToNodeFrame = { type: "ack", sessionId: frame.sessionId, recordId };
			socket.send(JSON.stringify(ack));
		});
	});

	const starting = link.start();
	const socket = await drained.promise;
	const pending = await Promise.all(
		sessionIds.map(async (sessionId, index) => ({
			sessionId,
			records: await link.append(sessionId, [{ type: "stats", contextTokens: 42 + index, model: null }]),
		})),
	);
	for (const sessionId of sessionIds) assert.equal(existsSync(join(spoolDir, `${sessionId}.jsonl`)), true);
	const ready: PlaneToNodeFrame = { type: "ready", recover: [] };
	socket.send(JSON.stringify(ready));
	await starting;

	assert.equal(received.length, sessionIds.length);
	for (const expected of pending) {
		assert.deepEqual(
			received.find((frame) => frame.sessionId === expected.sessionId),
			{ type: "records", ...expected },
		);
		assert.equal(existsSync(join(spoolDir, `${expected.sessionId}.jsonl`)), false);
	}

	const loadedSessionId = sessionIds[0];
	if (!loadedSessionId) throw new Error("The load boundary test needs a session");
	held.sessionId = loadedSessionId;
	const appending = link.append(loadedSessionId, [{ type: "stats", contextTokens: 100, model: null }]);
	const pendingFrame = await held.frame.promise;
	const spoolPath = join(spoolDir, `${loadedSessionId}.jsonl`);
	assert.equal(existsSync(spoolPath), true);
	assert.deepEqual(await link.load(loadedSessionId), canonical.get(loadedSessionId));
	assert.equal(existsSync(spoolPath), true);
	const recordId = pendingFrame.records.at(-1)?.recordId;
	if (!recordId) throw new Error("Held records frame was empty");
	const ack: PlaneToNodeFrame = { type: "ack", sessionId: loadedSessionId, recordId };
	socket.send(JSON.stringify(ack));
	await appending;
	assert.equal(existsSync(spoolPath), false);
});
