import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
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
// acknowledges. Returns without listening: the bin owns process concerns (port, signals, bind errors).
export function createDaemon(): Server {
	const harness = Engine.createHarness(Config.loadConfig());
	const log: Protocol.Event[] = [];
	const subscribers = new Set<ServerResponse>();
	let busy = false;

	// Append to the log and fan out one SSE frame. The frame id is the event's log index — the seed
	// for Last-Event-ID catch-up. The log grows unbounded in memory; nothing bounds or persists it.
	function broadcast(event: Protocol.Event): void {
		const frame = `id: ${log.length}\ndata: ${JSON.stringify(event)}\n\n`;
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
	// Never throws — a client abort mid-upload or bad JSON lands in the catch as a 400.
	async function handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
			res.writeHead(403).end();
			return;
		}
		const origin = req.headers.origin;
		if (origin !== undefined && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
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
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown };
			if (typeof parsed.text !== "string" || parsed.text.trim() === "") {
				res.writeHead(400).end();
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

	const server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ name: "ker", protocol: PROTOCOL_VERSION }));
			return;
		}
		// flushHeaders is load-bearing: Node buffers the header block until the first body write,
		// and a client awaiting fetch("/event") would deadlock against its own POST without it.
		if (req.method === "GET" && req.url === "/event") {
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
