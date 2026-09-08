import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as Protocol from "@ker-ai/protocol";
import {
	NODE_PROTOCOL_VERSION,
	type NodeToPlaneFrame,
	type PlaneToNodeFrame,
	PlaneToNodeFrame as PlaneToNodeFrameSchema,
} from "@ker-ai/protocol/node";
import type { Payload, StoredRecord } from "@ker-ai/store";
import { parseRecords, STORE_VERSION } from "@ker-ai/store";
import { Value } from "@sinclair/typebox/value";
import { type NodeIdentity, saveNodeServer } from "./identity.ts";
import { InvalidCwdError, type Node, type NodePlane, SessionUnreadableError } from "./node.ts";
import { Spool } from "./spool.ts";

const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_BACKOFF_MS = 60_000;
const CLOSE_TEXT_FRAME_REQUIRED = 4_003;
const CLOSE_POLICY_VIOLATION = 4_008;
const CLOSE_INTERNAL_ERROR = 4_011;
const CLOSE_HEARTBEAT_TIMEOUT = 4_013;

interface LinkOptions {
	serverUrl: string;
	token?: string;
	identity: NodeIdentity;
	identityPath: string;
	spoolDir?: string;
	onStatus?: (message: string) => void;
}

interface AckWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

interface LoadWaiter {
	sessionId: Protocol.SessionId;
	chunks: string[];
	resolve: (records: StoredRecord[]) => void;
	reject: (error: Error) => void;
}

export class Link implements NodePlane {
	readonly #serverUrl: string;
	readonly #identityPath: string;
	readonly #spool: Spool;
	readonly #onStatus: (message: string) => void;
	readonly #acks = new Map<string, AckWaiter>();
	readonly #loads = new Map<string, LoadWaiter>();
	readonly #flushes = new Map<Protocol.SessionId, Promise<void>>();
	readonly #calls = new Set<Promise<void>>();
	#identity: NodeIdentity;
	#token?: string;
	#node?: Node;
	#socket?: WebSocket;
	#ready = false;
	#stopping = false;
	#lastFrameAt = 0;
	#watchdog?: NodeJS.Timeout;
	#loop?: Promise<void>;
	#retry?: { timer: NodeJS.Timeout; resolve: () => void };
	#firstReady = Promise.withResolvers<void>();

	constructor(options: LinkOptions) {
		this.#serverUrl = options.serverUrl;
		this.#token = options.token;
		this.#identity = options.identity;
		this.#identityPath = options.identityPath;
		this.#spool = new Spool(options.spoolDir ?? join(homedir(), ".ker", "spool"));
		this.#onStatus = options.onStatus ?? (() => undefined);
	}

	attach(node: Node): void {
		this.#node = node;
	}

	async start(): Promise<void> {
		if (!this.#node) throw new Error("The node link is not attached");
		this.#loop ??= this.#connectLoop();
		return this.#firstReady.promise;
	}

	async shutdown(): Promise<void> {
		this.#stopping = true;
		this.#clearWatchdog();
		if (this.#retry) {
			clearTimeout(this.#retry.timer);
			this.#retry.resolve();
		}
		await this.#node?.shutdown();
		await Promise.all(this.#calls);
		await Promise.all(this.#flushes.values());
		await new Promise<void>((resolve) => setImmediate(resolve));
		await Promise.all(this.#flushes.values());
		this.#socket?.close(1000, "Node shutting down");
		await this.#loop;
	}

	async load(sessionId: Protocol.SessionId): Promise<StoredRecord[]> {
		const socket = this.#requireSocket();
		const id = randomUUID();
		const records = await new Promise<StoredRecord[]>((resolve, reject) => {
			this.#loads.set(id, { sessionId, chunks: [], resolve, reject });
			this.#send(socket, { type: "load", id, sessionId });
		});
		const canonicalIds = new Set(records.map((record) => record.recordId));
		const pending = this.#spool.pending(sessionId);
		const firstMissingIndex = pending.findIndex((record) => !canonicalIds.has(record.recordId));
		const acknowledgedCount = firstMissingIndex === -1 ? pending.length : firstMissingIndex;
		const acknowledged = acknowledgedCount === 0 ? undefined : pending.at(acknowledgedCount - 1);
		if (acknowledged) await this.#spool.acknowledge(sessionId, acknowledged.recordId);
		await this.#spool.open(sessionId, records.at(-1)?.recordId ?? null);
		return records;
	}

	async append(sessionId: Protocol.SessionId, payloads: Payload[]): Promise<StoredRecord[]> {
		const records = await this.#spool.append(sessionId, payloads);
		if (this.#ready) await this.#flush(sessionId).catch(() => undefined);
		return records;
	}

	publish(sessionId: Protocol.SessionId, event: Protocol.TurnEvent): void {
		if (event.type !== "message_delta" && event.type !== "reasoning_delta") return;
		const socket = this.#socket;
		if (!this.#ready || !socket || socket.readyState !== WebSocket.OPEN) return;
		this.#send(socket, { type: "delta", sessionId, event });
	}

	async #connectLoop(): Promise<void> {
		let backoff = 1_000;
		while (!this.#stopping) {
			try {
				await this.#connect();
				backoff = 1_000;
			} catch (error) {
				if (this.#stopping) return;
				if (error instanceof LinkRefusedError) {
					this.#firstReady.reject(error);
					this.#onStatus(`node connection refused: ${error.message}`);
					return;
				}
				this.#onStatus(`node connection lost: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (this.#stopping) return;
			await this.#waitForRetry(backoff);
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		}
	}

	async #connect(): Promise<void> {
		const node = this.#node;
		if (!node) throw new Error("The node link is not attached");
		const socket = new WebSocket(socketUrl(this.#serverUrl));
		this.#socket = socket;
		this.#lastFrameAt = Date.now();
		const closed = Promise.withResolvers<void>();
		let closeReason = "Node socket disconnected";
		let operationError: unknown;
		let operations = Promise.resolve();
		socket.addEventListener("message", (message) => {
			operations = operations.then(() => this.#receive(socket, message.data));
			operations.catch((error: unknown) => {
				operationError = error;
				if (error instanceof LinkRefusedError) return;
				this.#onStatus(`node frame failed: ${error instanceof Error ? error.message : String(error)}`);
				socket.close(CLOSE_INTERNAL_ERROR, "Node frame failed");
			});
		});
		socket.addEventListener("close", (event) => {
			closeReason = event.reason
				? `Node socket disconnected (${event.code}: ${event.reason})`
				: `Node socket disconnected (${event.code})`;
			closed.resolve();
		});
		socket.addEventListener("error", () => undefined);
		await waitForOpen(socket);
		this.#send(
			socket,
			this.#token
				? {
						type: "enroll",
						token: this.#token,
						identity: {
							id: this.#identity.id,
							name: this.#identity.name,
							createdAt: this.#identity.createdAt,
						},
					}
				: {
						type: "auth",
						nodeId: this.#identity.id,
						secret: this.#identity.server?.secret ?? "",
					},
		);
		this.#watchdog = setInterval(() => {
			if (Date.now() - this.#lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
				socket.close(CLOSE_HEARTBEAT_TIMEOUT, "Server heartbeat timed out");
			}
		}, 5_000);
		this.#watchdog.unref();
		await closed.promise;
		await operations.catch(() => undefined);
		this.#ready = false;
		this.#clearWatchdog();
		if (this.#socket === socket) this.#socket = undefined;
		const disconnected = new Error(closeReason);
		for (const waiter of this.#acks.values()) waiter.reject(disconnected);
		for (const waiter of this.#loads.values()) waiter.reject(disconnected);
		this.#acks.clear();
		this.#loads.clear();
		if (operationError) throw operationError;
		if (!this.#stopping) throw disconnected;
	}

	async #receive(socket: WebSocket, data: string | ArrayBuffer | Blob): Promise<void> {
		this.#lastFrameAt = Date.now();
		if (typeof data !== "string") {
			socket.close(CLOSE_TEXT_FRAME_REQUIRED, "Text frames required");
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data) as unknown;
		} catch {
			socket.close(CLOSE_POLICY_VIOLATION, "Invalid JSON frame");
			return;
		}
		if (!Value.Check(PlaneToNodeFrameSchema, parsed)) {
			socket.close(CLOSE_POLICY_VIOLATION, "Invalid plane frame");
			return;
		}
		if (parsed.type === "refused") {
			const error = new LinkRefusedError(parsed.message);
			this.#firstReady.reject(error);
			socket.close(CLOSE_POLICY_VIOLATION, "Refused");
			throw error;
		}
		if (parsed.type === "welcome") {
			if (parsed.secret) {
				const server = { url: this.#serverUrl, secret: parsed.secret };
				saveNodeServer(this.#identityPath, this.#identity, server);
				this.#identity = { ...this.#identity, server };
				this.#token = undefined;
			}
			this.#send(socket, {
				type: "hello",
				nodeProtocol: NODE_PROTOCOL_VERSION,
				storeVersion: STORE_VERSION,
				running: this.#node?.running() ?? [],
			});
			void this.#finishWelcome(socket);
			return;
		}
		if (parsed.type === "ready") {
			this.#ready = true;
			void this.#finishReady(socket, parsed.recover);
			return;
		}
		if (parsed.type === "hb") return;
		if (parsed.type === "ack") {
			await this.#spool.acknowledge(parsed.sessionId, parsed.recordId);
			const waiter = this.#acks.get(ackKey(parsed.sessionId, parsed.recordId));
			this.#acks.delete(ackKey(parsed.sessionId, parsed.recordId));
			waiter?.resolve();
			return;
		}
		if (parsed.type === "reject") {
			this.#onStatus(`record chain rejected for session ${parsed.sessionId}`);
			await this.#spool.drop(parsed.sessionId);
			await this.#node?.abortSession(parsed.sessionId);
			const waiter = this.#acks.get(ackKey(parsed.sessionId, parsed.recordId));
			this.#acks.delete(ackKey(parsed.sessionId, parsed.recordId));
			waiter?.reject(new Error(`Record chain rejected for session ${parsed.sessionId}`));
			return;
		}
		if (parsed.type === "chunk") {
			this.#loads.get(parsed.id)?.chunks.push(parsed.text);
			return;
		}
		if (parsed.type === "end") {
			const waiter = this.#loads.get(parsed.id);
			if (!waiter) return;
			this.#loads.delete(parsed.id);
			if (!parsed.found) {
				waiter.reject(new SessionUnreadableError(waiter.sessionId, "Session history is unavailable"));
				return;
			}
			try {
				waiter.resolve(parseRecords(waiter.chunks.join(""), "node history"));
			} catch (error) {
				waiter.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		if (parsed.type === "call") {
			const handling = this.#handleCall(socket, parsed).catch(() =>
				socket.close(CLOSE_INTERNAL_ERROR, "Node call failed"),
			);
			const tracked = handling.finally(() => this.#calls.delete(tracked));
			this.#calls.add(tracked);
		}
	}

	async #finishWelcome(socket: WebSocket): Promise<void> {
		try {
			await this.#drain(socket);
			this.#send(socket, { type: "drained" });
		} catch {
			socket.close(CLOSE_INTERNAL_ERROR, "Spool drain failed");
		}
	}

	async #finishReady(socket: WebSocket, recover: Protocol.SessionId[]): Promise<void> {
		try {
			const node = this.#node;
			if (!node) throw new Error("The node link is not attached");
			const recovery = await (recover.length > 0 ? node.recover(recover) : Promise.resolve()).then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			await this.#drain(socket);
			if (!recovery.ok) throw recovery.error;
			this.#firstReady.resolve();
			this.#onStatus(`node connected to ${this.#serverUrl}`);
		} catch (error) {
			const failures = error instanceof AggregateError ? error.errors : [error];
			if (failures.every((failure) => failure instanceof SessionUnreadableError)) {
				this.#firstReady.resolve();
				this.#onStatus(`node connected to ${this.#serverUrl}`);
				return;
			}
			socket.close(CLOSE_INTERNAL_ERROR, "Node recovery failed");
		}
	}

	async #handleCall(socket: WebSocket, frame: Extract<PlaneToNodeFrame, { type: "call" }>): Promise<void> {
		const node = this.#node;
		if (!node) throw new Error("The node link is not attached");
		try {
			const value = await dispatchCall(node, frame.method, frame.args);
			await Promise.all(this.#flushes.values());
			this.#send(socket, { type: "result", id: frame.id, value: value ?? null });
		} catch (error) {
			const code =
				error instanceof InvalidCwdError
					? "invalid_cwd"
					: error instanceof SessionUnreadableError
						? "unknown_session"
						: "internal";
			this.#send(socket, {
				type: "error",
				id: frame.id,
				code,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #drain(socket: WebSocket): Promise<void> {
		while (true) {
			const pending = await this.#spool.drain();
			const sessions = [...pending.entries()].filter(([, records]) => records.length > 0);
			if (sessions.length === 0) return;
			await Promise.all(sessions.map(([sessionId]) => this.#flush(sessionId, socket)));
		}
	}

	#flush(sessionId: Protocol.SessionId, socket = this.#socket): Promise<void> {
		const previous = this.#flushes.get(sessionId) ?? Promise.resolve();
		const flushing = previous.then(async () => {
			if (!socket || socket.readyState !== WebSocket.OPEN) return;
			const records = this.#spool.pending(sessionId);
			const recordId = records.at(-1)?.recordId;
			if (!recordId) return;
			await new Promise<void>((resolve, reject) => {
				this.#acks.set(ackKey(sessionId, recordId), { resolve, reject });
				this.#send(socket, { type: "records", sessionId, records });
			});
		});
		const tracked = flushing
			.catch(() => undefined)
			.finally(() => {
				if (this.#flushes.get(sessionId) === tracked) this.#flushes.delete(sessionId);
			});
		this.#flushes.set(sessionId, tracked);
		return flushing;
	}

	#requireSocket(): WebSocket {
		const socket = this.#socket;
		if (!this.#ready || !socket || socket.readyState !== WebSocket.OPEN) throw new Error("Node is not connected");
		return socket;
	}

	#send(socket: WebSocket, frame: NodeToPlaneFrame): void {
		socket.send(JSON.stringify(frame));
	}

	#clearWatchdog(): void {
		if (this.#watchdog) clearInterval(this.#watchdog);
		this.#watchdog = undefined;
	}

	async #waitForRetry(delay: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, delay);
			timer.unref();
			this.#retry = { timer, resolve };
		});
		this.#retry = undefined;
	}
}

export class LinkRefusedError extends Error {}

async function dispatchCall(node: Node, method: string, args: unknown[]): Promise<unknown> {
	if (method === "createSession") return node.createSession(requireString(args[0], method));
	if (method === "admit") return node.admit(requireString(args[0], method), requireString(args[1], method));
	if (method === "compact") {
		const instructions = args[1] === undefined ? undefined : requireString(args[1], method);
		return node.compact(requireString(args[0], method), instructions);
	}
	if (method === "cancel") return node.cancel(requireString(args[0], method), requireString(args[1], method));
	if (method === "recover") {
		if (!Array.isArray(args[0]) || args[0].some((value) => typeof value !== "string")) {
			throw new Error("Invalid recover arguments");
		}
		if (args[1] !== undefined && typeof args[1] !== "boolean") throw new Error("Invalid recover arguments");
		return node.recover(args[0] as string[], args[1] ?? false);
	}
	if (method === "resolveProjectRoot") return node.resolveProjectRoot(requireString(args[0], method));
	if (method === "observeGitRemote") return node.observeGitRemote(requireString(args[0], method));
	if (method === "folderExists") return node.folderExists(requireString(args[0], method));
	throw new Error(`Unknown node method ${method}`);
}

function requireString(value: unknown, method: string): string {
	if (typeof value !== "string") throw new Error(`Invalid ${method} arguments`);
	return value;
}

function waitForOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("Could not connect to the server")), { once: true });
	});
}

function socketUrl(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/nodes/socket";
	url.search = "";
	url.hash = "";
	return url.toString();
}

function ackKey(sessionId: Protocol.SessionId, recordId: string): string {
	return `${sessionId}:${recordId}`;
}
