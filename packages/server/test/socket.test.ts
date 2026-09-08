import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_PROTOCOL_VERSION, type PlaneToNodeFrame } from "@ker-ai/protocol/node";
import { STORE_VERSION } from "@ker-ai/store";
import WebSocket from "ws";
import { createServer } from "../src/index.ts";

test("refreshes node liveness and disconnects after two missed heartbeat pongs", { timeout: 2_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-server-heartbeat-"));
	const server = createServer({
		sessionDir: join(root, "sessions"),
		catalogPath: join(root, "catalog.db"),
		nodeHeartbeatMs: 20,
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	t.after(async () => {
		await server.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(root, { recursive: true, force: true });
	});
	await server.ready;
	const address = server.address();
	assert(address && typeof address !== "string");
	const enrollment = server.plane.createEnrollment(`http://127.0.0.1:${(address as AddressInfo).port}`);
	const socket = new WebSocket(`ws://127.0.0.1:${(address as AddressInfo).port}/nodes/socket`, { autoPong: false });
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});

	const nodeId = "00000000-0000-4000-8000-000000000001";
	const welcomed = receiveFrame(socket, "welcome");
	socket.send(
		JSON.stringify({
			type: "enroll",
			token: enrollment.token,
			identity: { id: nodeId, name: "Silent node", createdAt: "2026-09-08T00:00:00.000Z" },
		}),
	);
	await welcomed;
	const ready = receiveFrame(socket, "ready");
	socket.send(
		JSON.stringify({ type: "hello", nodeProtocol: NODE_PROTOCOL_VERSION, storeVersion: STORE_VERSION, running: [] }),
	);
	socket.send(JSON.stringify({ type: "drained" }));
	await ready;
	const connectedNode = server.plane.listNodes().find((node) => node.id === nodeId);
	assert.equal(connectedNode?.connected, true);
	assert(connectedNode.lastSeenAt);
	await new Promise<void>((resolve) => {
		socket.once("ping", () => {
			socket.pong();
			resolve();
		});
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	const heartbeatLastSeen = server.plane.listNodes().find((node) => node.id === nodeId)?.lastSeenAt;
	assert(heartbeatLastSeen);
	assert(heartbeatLastSeen > connectedNode.lastSeenAt);

	const closeCode = await new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
	assert.equal(closeCode, 1006);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(server.plane.listNodes().find((node) => node.id === nodeId)?.connected, false);
});

async function receiveFrame<Type extends PlaneToNodeFrame["type"]>(
	socket: WebSocket,
	type: Type,
): Promise<Extract<PlaneToNodeFrame, { type: Type }>> {
	while (true) {
		const frame = await new Promise<PlaneToNodeFrame>((resolve) => {
			socket.once("message", (data) => resolve(JSON.parse(data.toString()) as PlaneToNodeFrame));
		});
		if (frame.type === type) return frame as Extract<PlaneToNodeFrame, { type: Type }>;
	}
}
