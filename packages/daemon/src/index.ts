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
// acknowledges. An idle reset clears the model context, trims the event log, and tells every
// subscriber. Returns without listening: the bin owns process concerns (port, signals, bind errors).
export function createDaemon(harness: Harness = createConfiguredHarness()): Server {
	const log: Protocol.Event[] = [];
	const subscribers = new Set<ServerResponse>();
	let busy = false;
	let generation = 0;
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

	// Fire-and-forget turn driver. The catch turns a failure in the turn into a terminal error event —
	// an unhandled rejection here would take down the whole daemon; the finally frees the turn slot.
	// With no abort or timeout, a turn that never completes holds the slot and every later prompt 409s
	// until the daemon restarts.
	function pump(text: string): void {
		busy = true;
		void (async () => {
			try {
				for await (const event of harness.send(text)) broadcast(event);
			} catch (err) {
				broadcast({ role: "assistant", type: "error", message: err instanceof Error ? err.message : String(err) });
			} finally {
				busy = false;
			}
		})();
	}

	// Guard a prompt submission: Host/Origin checks keep browser pages from driving the agent
	// cross-origin until real auth exists; the size cap is checked both up front and mid-read.
	// The prompt must name the conversation generation it was composed against, so a prompt in
	// flight during a reset is refused (412) instead of landing in the fresh conversation.
	// Never throws — a client abort mid-upload or bad JSON lands in the catch as a 400.
	async function handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!isLocalRequest(req)) {
			res.writeHead(403).end();
			return;
		}
		if (!req.headers["content-type"]?.startsWith("application/json")) {
			res.writeHead(415).end();
			return;
		}
		if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
			res.writeHead(413).end();
			return;
		}
		try {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					res.writeHead(413).end();
					return;
				}
				chunks.push(chunk);
			}
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown; generation?: unknown };
			if (typeof parsed.text !== "string" || parsed.text.trim() === "" || typeof parsed.generation !== "number") {
				res.writeHead(400).end();
				return;
			}
			if (parsed.generation !== generation) {
				res.writeHead(412).end();
				return;
			}
			if (busy) {
				res.writeHead(409).end();
				return;
			}
			pump(parsed.text);
			res.writeHead(202).end();
		} catch {
			res.writeHead(400).end();
		}
	}

	function handleNewConversation(req: IncomingMessage, res: ServerResponse): void {
		if (!isLocalRequest(req)) {
			res.writeHead(403).end();
			return;
		}
		if (busy) {
			res.writeHead(409).end();
			return;
		}
		harness.reset();
		generation++;
		idBase += log.length;
		log.length = 0;
		broadcast({ role: "system", type: "conversation_reset" });
		res.writeHead(204).end();
	}

	const server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ name: "ker", protocol: PROTOCOL_VERSION, generation }));
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
	send(text: string): AsyncIterable<Protocol.Event>;
}

function createConfiguredHarness(): Harness {
	const config = Config.loadConfig();
	return Engine.createHarness({
		model: config.model,
		getAuth: () => Auth.resolveAuth(config.apiKey),
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
