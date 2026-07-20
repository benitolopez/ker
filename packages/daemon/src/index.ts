import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import * as Agent from "@ker-ai/agent";
import * as Auth from "@ker-ai/auth";
import * as Config from "@ker-ai/config";
import * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker-ai/protocol";

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${DEFAULT_PORT}`, `localhost:${DEFAULT_PORT}`]);

// Hosts one in-memory conversation and owns prompt admission. An active turn keeps a FIFO of steering
// messages that the engine reads synchronously at model boundaries. Closing that FIFO and observing it
// empty happen in the same callback, so later submissions wait for cleanup and start the next turn.
export function createDaemon(harness: Harness = createConfiguredHarness()): Server {
	const log: Protocol.Event[] = [];
	const subscribers = new Set<ServerResponse>();
	let sessionId: Protocol.SessionId = randomUUID();
	let activeTurn: ActiveTurn | undefined;
	let idBase = 0;

	// Append to the log and fan out one SSE frame. The frame id is only the event-log cursor.
	function broadcast(event: Protocol.Event): void {
		const frame = `id: ${idBase + log.length}\ndata: ${JSON.stringify(event)}\n\n`;
		log.push(event);
		for (const res of subscribers) {
			if (!res.destroyed) res.write(frame);
		}
	}

	function takeSteering(turn: ActiveTurn, closeIfEmpty: boolean): Engine.UserMessage | undefined {
		const message = turn.steering.shift();
		if (message) return message;
		if (closeIfEmpty) turn.accepting = false;
		return undefined;
	}

	function removePending(turn: ActiveTurn, messageId: Protocol.MessageId): void {
		const index = turn.pending.findIndex((message) => message.messageId === messageId);
		if (index !== -1) turn.pending.splice(index, 1);
	}

	function flushUndelivered(turn: ActiveTurn, reason: "aborted" | "error"): void {
		for (const message of turn.pending) {
			broadcast({
				actor: "process",
				sessionId: turn.sessionId,
				turnId: turn.turnId,
				type: "message_undelivered",
				messageId: message.messageId,
				text: message.text,
				reason,
			});
		}
		turn.pending.length = 0;
		turn.steering.length = 0;
	}

	function flushTerminalPending(turn: ActiveTurn, failureReason?: "aborted" | "error"): void {
		const reason = failureReason ?? (turn.pending.length > 0 ? "error" : undefined);
		if (!failureReason && reason) {
			broadcast({
				actor: "process",
				sessionId: turn.sessionId,
				turnId: turn.turnId,
				type: "error",
				message: "The turn ended before every submitted message was delivered",
			});
		}
		if (reason) flushUndelivered(turn, reason);
	}

	// Drive one turn independently of its submitting client and keep end last on every terminal path.
	function pump(turn: ActiveTurn): void {
		void (async () => {
			let failureReason: "aborted" | "error" | undefined;
			try {
				for await (const event of harness.send(
					{
						initial: turn.initial,
						takeSteering: (closeIfEmpty) => takeSteering(turn, closeIfEmpty),
					},
					turn.controller.signal,
				)) {
					if (turn.terminal) continue;
					if (event.type === "message_delivered") removePending(turn, event.messageId);
					if (event.type === "aborted") {
						turn.accepting = false;
						failureReason = "aborted";
					}
					if (event.type === "error") {
						turn.accepting = false;
						failureReason = "error";
					}
					if (event.type === "end") {
						turn.accepting = false;
						flushTerminalPending(turn, failureReason);
						turn.terminal = true;
						broadcast(event);
						break;
					}
					broadcast(event);
				}
			} catch (err) {
				turn.accepting = false;
				if (!failureReason && turn.controller.signal.aborted) {
					failureReason = "aborted";
					broadcast({
						actor: "process",
						sessionId: turn.sessionId,
						turnId: turn.turnId,
						type: "aborted",
					});
				}
				if (!failureReason) {
					failureReason = "error";
					broadcast({
						actor: "process",
						sessionId: turn.sessionId,
						turnId: turn.turnId,
						type: "error",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			} finally {
				if (!turn.terminal) {
					turn.accepting = false;
					flushTerminalPending(turn, failureReason);
					turn.terminal = true;
					broadcast({
						actor: "process",
						sessionId: turn.sessionId,
						turnId: turn.turnId,
						type: "end",
					});
				}
				if (activeTurn === turn) activeTurn = undefined;
				turn.done.resolve();
			}
		})();
	}

	// Validate one prompt, then either append it to the open active turn or start a new turn. A request
	// that reaches admission during cleanup waits and is evaluated again against the current session.
	async function handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!isLocalRequest(req)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const parsed = await readJsonBody(req, res);
			if (
				!isRecord(parsed) ||
				typeof parsed.text !== "string" ||
				parsed.text.trim() === "" ||
				typeof parsed.sessionId !== "string"
			) {
				if (parsed !== undefined) res.writeHead(400).end();
				return;
			}
			if (parsed.sessionId !== sessionId) {
				res.writeHead(412).end();
				return;
			}

			while (activeTurn && !activeTurn.accepting) await activeTurn.done.promise;
			if (parsed.sessionId !== sessionId) {
				res.writeHead(412).end();
				return;
			}

			const turn = activeTurn;
			if (turn) {
				const message: Engine.UserMessage = {
					sessionId,
					turnId: turn.turnId,
					messageId: randomUUID(),
					text: parsed.text,
				};
				const submitted: Protocol.MessageSubmittedEvent = {
					actor: "human",
					sessionId,
					turnId: turn.turnId,
					type: "message_submitted",
					messageId: message.messageId,
					text: message.text,
					queued: true,
				};
				turn.pending.push(message);
				turn.steering.push(message);
				broadcast(submitted);
				writeJson(res, 202, submitted);
				return;
			}

			const message: Engine.UserMessage = {
				sessionId,
				turnId: randomUUID(),
				messageId: randomUUID(),
				text: parsed.text,
			};
			const nextTurn: ActiveTurn = {
				sessionId,
				turnId: message.turnId,
				initial: message,
				pending: [message],
				steering: [],
				accepting: true,
				controller: new AbortController(),
				done: Promise.withResolvers<void>(),
				terminal: false,
			};
			const submitted: Protocol.MessageSubmittedEvent = {
				actor: "human",
				sessionId,
				turnId: nextTurn.turnId,
				type: "message_submitted",
				messageId: message.messageId,
				text: message.text,
				queued: false,
			};
			activeTurn = nextTurn;
			broadcast(submitted);
			pump(nextTurn);
			writeJson(res, 202, submitted);
		} catch {
			if (!res.headersSent) res.writeHead(400).end();
		}
	}

	async function handleAbort(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!isLocalRequest(req)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const parsed = await readJsonBody(req, res);
			if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || typeof parsed.turnId !== "string") {
				if (parsed !== undefined) res.writeHead(400).end();
				return;
			}
			const turn = activeTurn;
			if (!turn || turn.terminal || parsed.sessionId !== turn.sessionId || parsed.turnId !== turn.turnId) {
				res.writeHead(409).end();
				return;
			}
			turn.accepting = false;
			turn.controller.abort();
			await turn.done.promise;
			res.writeHead(204).end();
		} catch {
			if (!res.headersSent) res.writeHead(400).end();
		}
	}

	function handleNewConversation(req: IncomingMessage, res: ServerResponse): void {
		if (!isLocalRequest(req)) {
			res.writeHead(403).end();
			return;
		}
		if (activeTurn) {
			res.writeHead(409).end();
			return;
		}
		harness.reset();
		sessionId = randomUUID();
		idBase += log.length;
		log.length = 0;
		broadcast({ actor: "process", sessionId, type: "conversation_reset" });
		writeJson(res, 201, { sessionId });
	}

	// The event route flushes headers immediately because clients subscribe before sending their prompt.
	const server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			writeJson(res, 200, { name: "ker", protocol: PROTOCOL_VERSION, sessionId });
			return;
		}
		if (req.method === "GET" && req.url === "/event") {
			if (!isLocalRequest(req)) {
				res.writeHead(403).end();
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			res.flushHeaders();
			subscribers.add(res);
			res.on("close", () => subscribers.delete(res));
			return;
		}
		if (req.method === "POST" && req.url === "/prompt") {
			void handlePrompt(req, res);
			return;
		}
		if (req.method === "POST" && req.url === "/turn/abort") {
			void handleAbort(req, res);
			return;
		}
		if (req.method === "POST" && req.url === "/conversation/new") {
			handleNewConversation(req, res);
			return;
		}
		res.writeHead(404).end();
	});

	// Keep quiet streams alive without holding the daemon process open.
	const heartbeat = setInterval(() => {
		for (const res of subscribers) {
			if (!res.destroyed) res.write(": hb\n\n");
		}
	}, HEARTBEAT_MS);
	heartbeat.unref();

	return server;
}

interface Harness {
	reset(): void;
	send(input: Engine.TurnInput, signal?: AbortSignal): AsyncIterable<Protocol.TurnEvent>;
}

interface ActiveTurn {
	sessionId: Protocol.SessionId;
	turnId: Protocol.TurnId;
	initial: Engine.UserMessage;
	pending: Engine.UserMessage[];
	steering: Engine.UserMessage[];
	accepting: boolean;
	controller: AbortController;
	done: PromiseWithResolvers<void>;
	terminal: boolean;
}

function createConfiguredHarness(): Harness {
	const config = Config.loadConfig();
	return Engine.createHarness({
		model: config.model,
		getAuth: (signal) => Auth.resolveAuth(config.apiKey, signal),
		tools: Agent.tools,
		systemPrompt: Agent.systemPrompt,
		reasoningEffort: config.reasoningEffort,
	});
}

function isLocalRequest(req: IncomingMessage): boolean {
	if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return false;
	const origin = req.headers.origin;
	return origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
	if (!req.headers["content-type"]?.startsWith("application/json")) {
		res.writeHead(415).end();
		return undefined;
	}
	if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
		res.writeHead(413).end();
		return undefined;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			res.writeHead(413).end();
			return undefined;
		}
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function writeJson(res: ServerResponse, status: number, body: object): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
