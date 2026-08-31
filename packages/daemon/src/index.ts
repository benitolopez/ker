import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import * as Agent from "@ker-ai/agent";
import * as Config from "@ker-ai/config";
import * as Protocol from "@ker-ai/protocol";
import { createOpenApiJson } from "@ker-ai/protocol/openapi";
import { type RouteDefinition, type RouteKey, routes } from "@ker-ai/protocol/routes";
import { Value } from "@sinclair/typebox/value";
import { defaultCatalogPath } from "./catalog.ts";
import { defaultNodePath } from "./identity.ts";
import { createConfiguredHarness, InvalidCwdError, Node, type NodeOptions, SessionUnreadableError } from "./node.ts";
import { ControlPlane } from "./plane.ts";
import { SessionStore } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_TAIL_SIZE = 2_000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${Protocol.DEFAULT_PORT}`, `localhost:${Protocol.DEFAULT_PORT}`]);
const OPENAPI_JSON = createOpenApiJson();
const BODY_REJECTED = Symbol("body_rejected");

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
	guiDir?: string;
}

export type Daemon = Server & { shutdown(): Promise<void> };

interface RequestContext {
	manager: ControlPlane;
	subscribers: Set<ServerResponse>;
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
	params: Record<string, string>;
	query: Record<string, string | number | undefined>;
	body: unknown;
}

type Handler = (context: RequestContext) => Promise<void> | void;
type HandlerMap = { [Key in RouteKey]: Handler };

// The HTTP server is synchronous to construct; session discovery and recovery finish before a route responds.
export function createDaemon(options: DaemonOptions = {}): Daemon {
	const subscribers = new Set<ServerResponse>();
	const guiDir = options.guiDir ?? defaultGuiDir();
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
		void handleRequest(manager, subscribers, guiDir, req, res);
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
	guiDir: string | undefined,
	req: IncomingMessage,
	res: ServerResponse,
) {
	if (!isLocalRequest(req)) {
		writeJson(res, 403, { code: "forbidden" });
		return;
	}
	try {
		const manager = await managerPromise;
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const match = matchRoute(req.method, url.pathname);
		if (!match) {
			if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
				await serveGui(guiDir, url.pathname, res);
				return;
			}
			writeJson(res, 404, { code: "not_found" });
			return;
		}
		const query = readQuery(match.route, url);
		if (!query) {
			writeJson(res, 400, { code: match.key === "events" ? "invalid_cursor" : "invalid_scope" });
			return;
		}
		const body = match.route.body ? await readJsonBody(req, res) : undefined;
		if (body === BODY_REJECTED) return;
		if (match.route.body && !Value.Check(match.route.body, body)) {
			writeJson(res, 400, { code: invalidBodyCode(match.key) });
			return;
		}
		await handlers[match.key]({ manager, subscribers, req, res, url, params: match.params, query, body });
	} catch (error) {
		if (!res.headersSent) {
			if (error instanceof InvalidCwdError) {
				writeJson(res, 400, { code: "invalid_cwd" });
				return;
			}
			if (error instanceof SessionUnreadableError) {
				writeJson(res, 500, { code: "session_unreadable", message: error.message });
				return;
			}
			if (error instanceof SyntaxError) {
				writeJson(res, 400, { code: "invalid_json", message: error.message });
				return;
			}
			writeJson(res, 500, {
				code: "internal",
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		res.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}

const handlers = {
	health: ({ res }) => {
		writeJson(res, 200, { name: "ker", protocol: Protocol.PROTOCOL_VERSION });
	},
	openapi: ({ res }) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(OPENAPI_JSON);
	},
	listProjects: ({ manager, res }) => {
		const body: Protocol.ListProjectsResponse = { projects: manager.listProjects() };
		writeJson(res, 200, body);
	},
	listProjectSessions: ({ manager, res, params }) => {
		const sessions = manager.listProjectSessions(params.projectId);
		if (sessions === "missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		const body: Protocol.ListSessionsResponse = { sessions };
		writeJson(res, 200, body);
	},
	createProjectSession: async ({ manager, res, params }) => {
		const created = await manager.createProjectSession(params.projectId);
		if (created === "missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		if (created === "ambiguous") {
			writeJson(res, 409, { code: "workspace_ambiguous" });
			return;
		}
		writeJson(res, 201, created);
	},
	createSession: async ({ manager, res, body }) => {
		const request = body as Protocol.CreateSessionRequest;
		writeJson(res, 201, await manager.createSession(request.cwd));
	},
	listSessions: async ({ manager, res, url }) => {
		const parameters = [...url.searchParams.entries()];
		if (parameters.length === 1 && parameters[0][0] === "scope" && parameters[0][1] === "all") {
			const body: Protocol.ListSessionsResponse = { sessions: manager.listSessions() };
			writeJson(res, 200, body);
			return;
		}
		if (parameters.length !== 1 || parameters[0][0] !== "cwd") {
			writeJson(res, 400, { code: "invalid_scope" });
			return;
		}
		const projectRoot = await manager.resolveProjectRoot(parameters[0][1]);
		const body: Protocol.ListSessionsResponse = { sessions: manager.listSessions({ projectRoot }) };
		writeJson(res, 200, body);
	},
	snapshot: async ({ manager, res, params }) => {
		const sessionId = params.sessionId;
		if (writeUnreadableSession(manager, sessionId, res)) return;
		const snapshot = await manager.snapshot(sessionId);
		if (!snapshot) {
			writeJson(res, 404, { code: "session_not_found" });
			return;
		}
		writeJson(res, 200, snapshot);
	},
	events: async ({ manager, subscribers, res, params, query }) => {
		const sessionId = params.sessionId;
		if (writeUnreadableSession(manager, sessionId, res)) return;
		const cursor: Protocol.Cursor = { epoch: String(query.epoch), sequence: Number(query.sequence) };
		const stream = { active: false, pending: [] as Protocol.EventEnvelope[] };
		const subscription = await manager.subscribe(sessionId, cursor, (envelope) => {
			if (!stream.active) {
				stream.pending.push(envelope);
				return;
			}
			writeEvent(res, envelope);
		});
		if (subscription === "missing") {
			writeJson(res, 404, { code: "session_not_found" });
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
	},
	prompt: async ({ manager, res, params, body }) => {
		const sessionId = params.sessionId;
		if (writeUnreadableSession(manager, sessionId, res)) return;
		const admitted = await manager.admit(sessionId, (body as Protocol.PromptRequest).text);
		if (admitted === "missing") {
			writeJson(res, 404, { code: "session_not_found" });
			return;
		}
		if (admitted === "context_exhausted") {
			writeJson(res, 409, { code: "context_exhausted" });
			return;
		}
		writeJson(res, 202, admitted);
	},
	compact: async ({ manager, res, params, body }) => {
		const sessionId = params.sessionId;
		if (writeUnreadableSession(manager, sessionId, res)) return;
		const admitted = await manager.compactNow(sessionId, (body as Protocol.CompactRequest).instructions);
		if (admitted === "missing") {
			writeJson(res, 404, { code: "session_not_found" });
			return;
		}
		writeJson(res, 202, admitted);
	},
	cancel: async ({ manager, res, params }) => {
		const sessionId = params.sessionId;
		if (writeUnreadableSession(manager, sessionId, res)) return;
		const result = await manager.cancel(sessionId, params.turnId);
		if (result === "missing") {
			writeJson(res, 404, { code: "session_not_found" });
			return;
		}
		if (result === "turn_unavailable") {
			writeJson(res, 409, { code: "turn_unavailable" });
			return;
		}
		writeJson(res, result.status === "cancelling" ? 202 : 200, result);
	},
} satisfies HandlerMap;

function matchRoute(
	method: string | undefined,
	pathname: string,
): { key: RouteKey; route: RouteDefinition; params: Record<string, string> } | undefined {
	for (const [key, route] of Object.entries(routes) as Array<[RouteKey, RouteDefinition]>) {
		if (route.method !== method) continue;
		const templateSegments = route.path.split("/");
		const pathSegments = pathname.split("/");
		if (templateSegments.length !== pathSegments.length) continue;
		const params: Record<string, string> = {};
		const matches = templateSegments.every((template, index) => {
			const segment = pathSegments[index];
			const parameter = template.match(/^\{(.+)\}$/)?.[1];
			if (!parameter) return template === segment;
			const schema = route.params?.[parameter];
			if (!schema) return false;
			params[parameter] = decodeURIComponent(segment);
			return Value.Check(schema, params[parameter]);
		});
		if (matches) return { key, route, params };
	}
	return undefined;
}

function readQuery(route: RouteDefinition, url: URL): Record<string, string | number | undefined> | undefined {
	const query: Record<string, string | number | undefined> = {};
	for (const [name, parameter] of Object.entries(route.query ?? {})) {
		const raw = url.searchParams.get(name);
		if (raw === null && parameter.required) return undefined;
		if (raw === null) {
			query[name] = undefined;
			continue;
		}
		const value = parameter.coerce === "integer" ? Number(raw) : raw;
		if (!Value.Check(parameter.schema, value)) return undefined;
		query[name] = value;
	}
	return query;
}

function invalidBodyCode(key: RouteKey): string {
	if (key === "createSession") return "invalid_cwd";
	if (key === "prompt") return "invalid_prompt";
	if (key === "compact") return "invalid_compaction";
	throw new Error(`Route ${key} has no request body`);
}

function writeUnreadableSession(manager: ControlPlane, sessionId: Protocol.SessionId, res: ServerResponse): boolean {
	const unreadable = manager.unreadableSession(sessionId);
	if (!unreadable) return false;
	writeJson(res, 500, { code: "session_unreadable", message: unreadable.error ?? "Session log is unreadable" });
	return true;
}

function isLocalRequest(req: IncomingMessage): boolean {
	if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return false;
	const origin = req.headers.origin;
	return origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function defaultGuiDir(): string | undefined {
	try {
		const packagePath = createRequire(import.meta.url).resolve("@ker-ai/gui/package.json");
		return resolve(dirname(packagePath), "dist");
	} catch {
		return undefined;
	}
}

async function serveGui(guiDir: string | undefined, pathname: string, res: ServerResponse): Promise<void> {
	if (pathname === "/" && !guiDir) {
		writeGuiHint(res);
		return;
	}
	if (!guiDir) {
		writeJson(res, 404, { code: "not_found" });
		return;
	}
	const decoded = decodeGuiPath(pathname);
	if (!decoded) {
		writeJson(res, 404, { code: "not_found" });
		return;
	}
	const filePath = resolve(guiDir, decoded === "/" ? "index.html" : decoded.slice(1));
	const pathFromGui = relative(guiDir, filePath);
	if (pathFromGui.startsWith("..") || isAbsolute(pathFromGui)) {
		writeJson(res, 404, { code: "not_found" });
		return;
	}
	try {
		const body = await readFile(filePath);
		res.writeHead(200, {
			"content-type": contentType(filePath),
			"cache-control": pathname === "/" ? "no-cache" : "public, max-age=31536000, immutable",
		});
		res.end(body);
	} catch (error) {
		if (pathname === "/") {
			writeGuiHint(res);
			return;
		}
		if (isMissingFile(error)) {
			writeJson(res, 404, { code: "not_found" });
			return;
		}
		throw error;
	}
}

function decodeGuiPath(pathname: string): string | undefined {
	try {
		const decoded = decodeURIComponent(pathname);
		return decoded.includes("\0") ? undefined : decoded;
	} catch {
		return undefined;
	}
}

function contentType(path: string): string {
	return (
		{
			".html": "text/html; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".svg": "image/svg+xml",
			".ico": "image/x-icon",
			".map": "application/json",
			".woff2": "font/woff2",
		}[extname(path)] ?? "application/octet-stream"
	);
}

function writeGuiHint(res: ServerResponse): void {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
	res.end(
		'<!doctype html><html><head><meta charset="utf-8"><title>ker</title></head><body><main><h1>ker GUI is not built</h1><p>Run <code>npm run build -w @ker-ai/gui</code>.</p></main></body></html>',
	);
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR")
	);
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | typeof BODY_REJECTED> {
	if (!req.headers["content-type"]?.startsWith("application/json")) {
		writeJson(res, 415, { code: "unsupported_media_type" });
		return BODY_REJECTED;
	}
	if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
		writeJson(res, 413, { code: "payload_too_large" });
		return BODY_REJECTED;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			writeJson(res, 413, { code: "payload_too_large" });
			return BODY_REJECTED;
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
