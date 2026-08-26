import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import * as Agent from "@ker-ai/agent";
import * as Config from "@ker-ai/config";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker-ai/protocol";
import { defaultCatalogPath } from "./catalog.ts";
import { defaultNodePath } from "./identity.ts";
import { createConfiguredHarness, InvalidCwdError, Node, type NodeOptions, SessionUnreadableError } from "./node.ts";
import { ControlPlane } from "./plane.ts";
import { SessionStore } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_TAIL_SIZE = 2_000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${DEFAULT_PORT}`, `localhost:${DEFAULT_PORT}`]);

export type { Harness } from "./node.ts";

export interface DaemonOptions {
	harnessFactory?: NodeOptions["harnessFactory"];
	definition?: NodeOptions["definition"];
	sessionDir?: string;
	catalogPath?: string;
	nodePath?: string;
	eventTailSize?: number;
	recoveryWindowMinutes?: number;
	compaction?: Config.CompactionSettings;
}

export type Daemon = Server & { shutdown(): Promise<void> };

// The HTTP server is synchronous to construct; session discovery and recovery finish before a route responds.
export function createDaemon(options: DaemonOptions = {}): Daemon {
	const subscribers = new Set<ServerResponse>();
	let plane: ControlPlane;
	const manager = (async () => {
		const config = Config.loadConfig();
		const node = new Node({
			store: new SessionStore({ baseDir: options.sessionDir }),
			nodePath: options.nodePath ?? defaultNodePath(),
			harnessFactory: options.harnessFactory ?? ((state, cwd) => createConfiguredHarness(state, cwd, config)),
			definition:
				options.definition ??
				((cwd) => {
					const { systemPrompt, tools, compaction } = Agent.createDefinition(cwd);
					return {
						systemPrompt,
						tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
						compaction,
					};
				}),
			eventTailSize: options.eventTailSize ?? DEFAULT_EVENT_TAIL_SIZE,
			recoveryWindowMinutes: options.recoveryWindowMinutes ?? config.recoveryWindowMinutes,
			compaction: options.compaction ?? config.compaction,
			onSessionChange: (change) => plane.applySessionChange(change),
		});
		plane = new ControlPlane({ node, catalogPath: options.catalogPath ?? defaultCatalogPath() });
		await plane.initialize();
		return plane;
	})();

	const server = createServer((req, res) => {
		void handleRequest(manager, subscribers, req, res);
	}) as Daemon;
	server.shutdown = async () => {
		const manager_ = await manager;
		await manager_.shutdown();
	};

	const heartbeat = setInterval(() => {
		for (const response of subscribers) {
			if (!response.destroyed) response.write(": hb\n\n");
		}
	}, HEARTBEAT_MS);
	heartbeat.unref();
	server.once("close", () => clearInterval(heartbeat));
	return server;
}

async function handleRequest(
	managerPromise: Promise<ControlPlane>,
	subscribers: Set<ServerResponse>,
	req: IncomingMessage,
	res: ServerResponse,
) {
	if (!isLocalRequest(req)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const manager = await managerPromise;
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		if (req.method === "GET" && url.pathname === "/health") {
			writeJson(res, 200, { name: "ker", protocol: PROTOCOL_VERSION });
			return;
		}
		if (req.method === "POST" && url.pathname === "/sessions") {
			const cwd = await readCreateSessionCwd(req, res);
			if (!cwd) return;
			writeJson(res, 201, await manager.createSession(cwd));
			return;
		}
		if (req.method === "GET" && url.pathname === "/sessions") {
			const scope = await readListSessionScope(manager, url, res);
			if (!scope) return;
			const body: Protocol.ListSessionsResponse = {
				sessions: scope.type === "all" ? manager.listSessions() : manager.listSessions(scope),
			};
			writeJson(res, 200, body);
			return;
		}
		const snapshotMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
		if (req.method === "GET" && snapshotMatch) {
			const sessionId = decodeURIComponent(snapshotMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const snapshot = await manager.snapshot(sessionId);
			if (!snapshot) {
				res.writeHead(404).end();
				return;
			}
			writeJson(res, 200, snapshot);
			return;
		}

		const eventMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
		if (req.method === "GET" && eventMatch) {
			const sessionId = decodeURIComponent(eventMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const sequence = Number(url.searchParams.get("sequence"));
			const epoch = url.searchParams.get("epoch");
			if (!epoch || !Number.isSafeInteger(sequence) || sequence < 0) {
				writeJson(res, 400, { code: "invalid_cursor" });
				return;
			}
			const stream = { active: false, pending: [] as Protocol.EventEnvelope[] };
			const subscription = await manager.subscribe(sessionId, { epoch, sequence }, (envelope) => {
				if (!stream.active) {
					stream.pending.push(envelope);
					return;
				}
				writeEvent(res, envelope);
			});
			if (subscription === "missing") {
				res.writeHead(404).end();
				return;
			}
			if (subscription === "resync") {
				writeJson(res, 410, { code: "resync_required" });
				return;
			}
			if (res.destroyed) {
				subscription.unsubscribe();
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			for (const envelope of subscription.replay) writeEvent(res, envelope);
			for (const envelope of stream.pending) writeEvent(res, envelope);
			stream.pending.length = 0;
			stream.active = true;
			res.flushHeaders();
			subscribers.add(res);
			res.on("close", () => {
				subscription.unsubscribe();
				subscribers.delete(res);
			});
			return;
		}

		const promptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompts$/);
		if (req.method === "POST" && promptMatch) {
			const sessionId = decodeURIComponent(promptMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const parsed = await readJsonBody(req, res);
			if (parsed === undefined) return;
			const prompt = parsePromptRequest(parsed);
			if (!prompt) {
				writeJson(res, 400, { code: "invalid_prompt" });
				return;
			}
			const admitted = await manager.admit(sessionId, prompt.text);
			if (admitted === "missing") {
				res.writeHead(404).end();
				return;
			}
			if (admitted === "context_exhausted") {
				writeJson(res, 409, { code: "context_exhausted" });
				return;
			}
			writeJson(res, 202, admitted);
			return;
		}

		const compactMatch = url.pathname.match(/^\/sessions\/([^/]+)\/compact$/);
		if (req.method === "POST" && compactMatch) {
			const sessionId = decodeURIComponent(compactMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const parsed = await readJsonBody(req, res);
			if (parsed === undefined) return;
			const compact = parseCompactRequest(parsed);
			if (!compact) {
				writeJson(res, 400, { code: "invalid_compaction" });
				return;
			}
			const admitted = await manager.compactNow(sessionId, compact.instructions);
			if (admitted === "missing") {
				res.writeHead(404).end();
				return;
			}
			writeJson(res, 202, admitted);
			return;
		}

		const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/cancel$/);
		if (req.method === "POST" && cancelMatch) {
			const sessionId = decodeURIComponent(cancelMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const result = await manager.cancel(sessionId, decodeURIComponent(cancelMatch[2]));
			if (result === "missing") {
				res.writeHead(404).end();
				return;
			}
			if (result === "turn_unavailable") {
				writeJson(res, 409, { code: "turn_unavailable" });
				return;
			}
			writeJson(res, result.status === "cancelling" ? 202 : 200, result);
			return;
		}
		res.writeHead(404).end();
	} catch (error) {
		if (!res.headersSent) {
			if (error instanceof InvalidCwdError) {
				writeJson(res, 400, { code: "invalid_cwd" });
				return;
			}
			if (error instanceof SessionUnreadableError) {
				writeJson(res, 500, { code: "session_unreadable", error: error.message });
				return;
			}
			writeJson(res, error instanceof SyntaxError ? 400 : 500, {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		res.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}

function writeUnreadableSession(manager: ControlPlane, sessionId: Protocol.SessionId, res: ServerResponse): boolean {
	const unreadable = manager.unreadableSession(sessionId);
	if (!unreadable) return false;
	writeJson(res, 500, { code: "session_unreadable", error: unreadable.error });
	return true;
}

interface PromptRequest {
	text: string;
}

type ListSessionScope = { type: "all" } | { type: "cwd"; projectRoot: string };

async function readCreateSessionCwd(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
	const parsed = await readJsonBody(req, res);
	if (parsed === undefined) return undefined;
	const request = parseCreateSessionRequest(parsed);
	if (!request) {
		writeJson(res, 400, { code: "invalid_cwd" });
		return undefined;
	}
	return request.cwd;
}

async function readListSessionScope(
	manager: ControlPlane,
	url: URL,
	res: ServerResponse,
): Promise<ListSessionScope | undefined> {
	const parameters = [...url.searchParams.entries()];
	if (parameters.length === 1 && parameters[0][0] === "scope" && parameters[0][1] === "all") {
		return { type: "all" };
	}
	if (parameters.length !== 1 || parameters[0][0] !== "cwd") {
		writeJson(res, 400, { code: "invalid_scope" });
		return undefined;
	}
	return { type: "cwd", projectRoot: await manager.resolveProjectRoot(parameters[0][1]) };
}

function parseCreateSessionRequest(value: unknown): Protocol.CreateSessionRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const request = value as Record<string, unknown>;
	if (Object.keys(request).length !== 1 || typeof request.cwd !== "string") return undefined;
	return { cwd: request.cwd };
}

function parsePromptRequest(value: unknown): PromptRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prompt = value as Record<string, unknown>;
	if (Object.keys(prompt).length !== 1 || typeof prompt.text !== "string" || prompt.text.trim() === "") {
		return undefined;
	}
	return { text: prompt.text };
}

function parseCompactRequest(value: unknown): Protocol.CompactRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const compact = value as Record<string, unknown>;
	if (Object.keys(compact).some((key) => key !== "instructions")) return undefined;
	if (
		compact.instructions !== undefined &&
		(typeof compact.instructions !== "string" || compact.instructions.trim() === "")
	) {
		return undefined;
	}
	return compact.instructions === undefined ? {} : { instructions: compact.instructions };
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

function writeEvent(res: ServerResponse, envelope: Protocol.EventEnvelope): void {
	if (res.destroyed) return;
	res.write(`id: ${envelope.epoch}:${envelope.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`);
}

function writeJson(res: ServerResponse, status: number, body: object): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
