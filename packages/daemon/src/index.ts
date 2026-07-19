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

// One harness (a single in-memory conversation) behind a hand-rolled HTTP+SSE server. The daemon
// runs each turn to completion itself — appending events to a log and writing them to SSE
// subscribers — so a turn keeps going even if the client disconnects; POST /prompt only
// acknowledges with the turn id. An idle reset creates a new session, clears the model context,
// trims the event log, and tells every subscriber. Returns without listening: the bin owns process
// concerns (port, signals, bind errors).
export function createDaemon(harness: Harness = createConfiguredHarness()): Server {
	const log: Protocol.Event[] = [];
	const subscribers = new Set<ServerResponse>();
	let sessionId: Protocol.SessionId = randomUUID();
	let activeTurn: ActiveTurn | undefined;
	let idBase = 0;

	// Append to the log and fan out one SSE frame. The frame id is idBase plus the log index — the
	// seed for Last-Event-ID catch-up. The log grows unbounded within a conversation; a reset empties
	// it and folds its length into idBase, so ids stay monotonic and discarded events are freed.
	function broadcast(event: Protocol.Event): void {
		const frame = `id: ${idBase + log.length}\ndata: ${JSON.stringify(event)}\n\n`;
		log.push(event);
		for (const res of subscribers) {
			if (!res.destroyed) res.write(frame);
		}
	}

	// Drive one accepted turn independently of its submitting client. Every path publishes one end,
	// marks the turn terminal before that frame is visible, and resolves done only after cleanup.
	function pump(text: string, turn: ActiveTurn): void {
		void (async () => {
			let sawAborted = false;
			try {
				for await (const event of harness.send(text, turn.controller.signal)) {
					if (turn.terminal) continue;
					if (event.type === "aborted") sawAborted = true;
					if (event.type === "end") {
						turn.terminal = true;
						broadcast(event);
						continue;
					}
					broadcast(event);
				}
			} catch (err) {
				if (!turn.terminal && turn.controller.signal.aborted && !sawAborted) {
					broadcast({ role: "assistant", type: "aborted" });
				}
				if (!turn.terminal && !turn.controller.signal.aborted) {
					broadcast({ role: "assistant", type: "error", message: err instanceof Error ? err.message : String(err) });
				}
			} finally {
				if (!turn.terminal) {
					turn.terminal = true;
					broadcast({ role: "assistant", type: "end" });
				}
				if (activeTurn === turn) activeTurn = undefined;
				turn.done.resolve();
			}
		})();
	}

	// Guard a prompt submission: Host/Origin checks keep browser pages from driving the agent
	// cross-origin until real auth exists; the size cap is checked both up front and mid-read.
	// The prompt must name the session it was composed against, so a prompt in flight during a reset
	// is refused (412) instead of landing in the fresh conversation.
	// Never throws — a client abort mid-upload or bad JSON lands in the catch as a 400.
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
			if (activeTurn) {
				res.writeHead(409).end();
				return;
			}
			const turn: ActiveTurn = {
				sessionId,
				turnId: randomUUID(),
				controller: new AbortController(),
				done: Promise.withResolvers<void>(),
				terminal: false,
			};
			activeTurn = turn;
			pump(parsed.text, turn);
			writeJson(res, 202, { turnId: turn.turnId });
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
		broadcast({ role: "system", type: "conversation_reset" });
		writeJson(res, 201, { sessionId });
	}

	const server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			writeJson(res, 200, { name: "ker", protocol: PROTOCOL_VERSION, sessionId });
			return;
		}
		// flushHeaders is load-bearing: Node buffers the header block until the first body write,
		// and a client awaiting fetch("/event") would deadlock against its own POST without it.
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

	// The heartbeat keeps intermediaries and undici's 300s idle body timeout from severing quiet
	// streams; unref'd so it never holds the process open once the server is gone.
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
	send(text: string, signal?: AbortSignal): AsyncIterable<Protocol.Event>;
}

interface ActiveTurn {
	sessionId: Protocol.SessionId;
	turnId: Protocol.TurnId;
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
