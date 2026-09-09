import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { NODE_PROTOCOL_VERSION, NodeToPlaneFrame, type PlaneToNodeFrame } from "@ker-ai/protocol/node";
import type { StoredRecord } from "@ker-ai/store";
import { STORE_VERSION } from "@ker-ai/store";
import { Value } from "@sinclair/typebox/value";
import WebSocket, { WebSocketServer } from "ws";
import { type Access, acceptsUpgrade } from "./access.ts";
import { RemoteNode } from "./nodes.ts";
import type { ControlPlane } from "./plane.ts";

const MAX_PAYLOAD = 16 * 1024 * 1024;
const CHUNK_CHARACTERS = 1024 * 1024;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const NODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function attachNodeSocket(
	server: Server,
	plane: ControlPlane,
	ready: Promise<void>,
	access: Access,
	heartbeatMs = HEARTBEAT_MS,
): () => Promise<void> {
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
	const state = { closed: false };
	const closeSockets = async () => {
		if (state.closed) return;
		state.closed = true;
		for (const socket of sockets.clients) socket.terminate();
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
	};
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		if (url.pathname !== "/nodes/socket" || !acceptsUpgrade(access, request)) {
			socket.destroy();
			return;
		}
		sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket, request));
	});
	sockets.on("connection", (socket) => handleConnection(socket, plane, ready, heartbeatMs));
	server.once("close", () => void closeSockets());
	return closeSockets;
}

function handleConnection(socket: WebSocket, plane: ControlPlane, ready: Promise<void>, heartbeatMs: number): void {
	let phase: "first" | "hello" | "draining" | "ready" = "first";
	let nodeId: string | undefined;
	let remote: RemoteNode | undefined;
	let running: string[] = [];
	let alive = true;
	let missedPongs = 0;
	let operations = Promise.resolve();
	const send = (frame: PlaneToNodeFrame) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
	};
	const refuse = (code: Extract<PlaneToNodeFrame, { type: "refused" }>["code"], message: string) => {
		send({ type: "refused", code, message });
		socket.close(1008, message.slice(0, 120));
	};
	const authTimeout = setTimeout(() => refuse("unauthorized", "Authentication timed out"), AUTH_TIMEOUT_MS);
	authTimeout.unref();
	const heartbeat = setInterval(() => {
		if (!alive) missedPongs++;
		if (missedPongs >= 2) {
			socket.terminate();
			return;
		}
		alive = false;
		socket.ping();
		send({ type: "hb" });
	}, heartbeatMs);
	heartbeat.unref();
	socket.on("pong", () => {
		alive = true;
		missedPongs = 0;
		if (nodeId && phase === "ready") plane.touchNode(nodeId);
	});
	socket.on("message", (data, isBinary) => {
		operations = operations
			.then(async () => {
				if (isBinary) {
					socket.close(1003, "Text frames required");
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(data.toString()) as unknown;
				} catch {
					socket.close(1008, "Invalid JSON frame");
					return;
				}
				if (!Value.Check(NodeToPlaneFrame, parsed)) {
					socket.close(1008, "Invalid node frame");
					return;
				}
				await ready;
				if (phase === "first") {
					if (parsed.type === "enroll") {
						if (!NODE_ID_PATTERN.test(parsed.identity.id)) {
							refuse("unauthorized", "Node id must be a UUID");
							return;
						}
						const consumed = plane.consumeEnrollmentToken(parsed.token);
						if (consumed !== "ok") {
							const code =
								consumed === "expired" ? "token_expired" : consumed === "used" ? "token_used" : "unauthorized";
							refuse(code, `Enrollment token is ${consumed}`);
							return;
						}
						const secret = randomBytes(32).toString("hex");
						plane.enrollNode(parsed.identity, secret);
						nodeId = parsed.identity.id;
						send({ type: "welcome", nodeId, secret });
						phase = "hello";
						clearTimeout(authTimeout);
						return;
					}
					if (parsed.type === "auth") {
						const verified = plane.verifyNodeSecret(parsed.nodeId, parsed.secret);
						if (verified !== "ok") {
							refuse(verified === "revoked" ? "revoked" : "unauthorized", "Node credentials were refused");
							return;
						}
						nodeId = parsed.nodeId;
						send({ type: "welcome", nodeId });
						phase = "hello";
						clearTimeout(authTimeout);
						return;
					}
					socket.close(1008, "Authentication frame required");
					return;
				}
				if (phase === "hello") {
					if (parsed.type !== "hello" || !nodeId) {
						socket.close(1008, "Hello frame required");
						return;
					}
					if (parsed.nodeProtocol !== NODE_PROTOCOL_VERSION || parsed.storeVersion !== STORE_VERSION) {
						refuse(
							"version_mismatch",
							`Server needs node protocol ${NODE_PROTOCOL_VERSION} and store ${STORE_VERSION}; node sent ${parsed.nodeProtocol} and ${parsed.storeVersion}`,
						);
						return;
					}
					const previous = plane.nodes.get(nodeId);
					if (previous instanceof RemoteNode) previous.disconnect();
					remote = new RemoteNode(nodeId, send, () => socket.close(1012, "Node connection replaced or revoked"));
					running = parsed.running;
					phase = "draining";
					return;
				}
				if (!nodeId || !remote) {
					socket.close(1008, "Handshake incomplete");
					return;
				}
				if (parsed.type === "records") {
					const records = parsed.records as StoredRecord[];
					const recordId = records.at(-1)?.recordId;
					if (!recordId) return;
					if (
						!plane.ownsSession(nodeId, parsed.sessionId) &&
						!plane.canCreateSession(nodeId, parsed.sessionId, records)
					) {
						if (!plane.hasSession(parsed.sessionId)) {
							send({ type: "reject", sessionId: parsed.sessionId, recordId, reason: "chain" });
							return;
						}
						socket.close(1008, "Session is owned by another node");
						return;
					}
					try {
						await plane.appendRecords(parsed.sessionId, records);
						send({ type: "ack", sessionId: parsed.sessionId, recordId });
					} catch {
						send({ type: "reject", sessionId: parsed.sessionId, recordId, reason: "chain" });
					}
					return;
				}
				if (parsed.type === "drained" && phase === "draining") {
					phase = "ready";
					plane.nodes.register(remote);
					plane.touchNode(nodeId);
					send({ type: "ready", recover: plane.readySessions(nodeId, running) });
					return;
				}
				if (phase !== "ready") {
					socket.close(1008, "Spool must drain before node traffic");
					return;
				}
				if (parsed.type === "delta") {
					if (!plane.ownsSession(nodeId, parsed.sessionId)) {
						socket.close(1008, "Session is owned by another node");
						return;
					}
					await plane.publishDelta(parsed.sessionId, parsed.event);
					return;
				}
				if (parsed.type === "load") {
					if (!plane.ownsSession(nodeId, parsed.sessionId)) {
						send({ type: "end", id: parsed.id, found: false });
						return;
					}
					try {
						const records = await plane.loadRecords(parsed.sessionId);
						let chunk = "";
						for (const record of records) {
							let remaining = `${JSON.stringify(record)}\n`;
							while (remaining.length > 0) {
								const take = Math.min(CHUNK_CHARACTERS - chunk.length, remaining.length);
								chunk += remaining.slice(0, take);
								remaining = remaining.slice(take);
								if (chunk.length < CHUNK_CHARACTERS) continue;
								while (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
									if (socket.readyState !== WebSocket.OPEN) throw new Error("Node disconnected during history load");
									await new Promise<void>((resolve) => setImmediate(resolve));
								}
								send({ type: "chunk", id: parsed.id, text: chunk });
								chunk = "";
							}
						}
						if (chunk) {
							while (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
								if (socket.readyState !== WebSocket.OPEN) throw new Error("Node disconnected during history load");
								await new Promise<void>((resolve) => setImmediate(resolve));
							}
							send({ type: "chunk", id: parsed.id, text: chunk });
						}
						send({ type: "end", id: parsed.id, found: true });
					} catch (error) {
						plane.markUnreadable(parsed.sessionId, error instanceof Error ? error.message : String(error));
						send({ type: "end", id: parsed.id, found: false });
					}
					return;
				}
				if (parsed.type === "result") {
					remote.resolve(parsed.id, parsed.value);
					return;
				}
				if (parsed.type === "error") remote.reject(parsed.id, parsed.code, parsed.message);
			})
			.catch((error: unknown) => {
				console.error("node socket frame failed:", error);
				socket.close(1011, "Node frame failed");
			});
	});
	socket.on("error", () => undefined);
	socket.on("close", () => {
		clearTimeout(authTimeout);
		clearInterval(heartbeat);
		remote?.close();
		if (nodeId && plane.nodes.get(nodeId) === remote) plane.nodes.unregister(nodeId);
	});
}
