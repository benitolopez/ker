import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import * as Protocol from "@ker-ai/protocol";
import { createOpenApiJson } from "@ker-ai/protocol/openapi";
import { type RouteDefinition, type RouteKey, routes } from "@ker-ai/protocol/routes";
import { SessionStore } from "@ker-ai/store";
import { Value } from "@sinclair/typebox/value";
import { ArchiveTooLargeError, InvalidArchiveError, MAX_ARCHIVE_BYTES, UnsupportedArchiveError } from "./archive.ts";
import { defaultCatalogPath, WorkspaceConflictError } from "./catalog.ts";
import { isLocalRequest } from "./local.ts";
import {
	NodeAmbiguousError,
	NodeNotFoundError,
	type NodeRegistry,
	NodeUnavailableError,
	RemoteCallError,
} from "./nodes.ts";
import { ControlPlane, LocalNodeError, SessionUnreadableError, WorkspaceNotFoundError } from "./plane.ts";
import { attachNodeSocket } from "./socket.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_TAIL_SIZE = 2_000;
const OPENAPI_JSON = createOpenApiJson();
const BODY_REJECTED = Symbol("body_rejected");

class PayloadTooLargeError extends InvalidArchiveError {}

export interface ServerOptions {
	sessionDir?: string;
	catalogPath?: string;
	eventTailSize?: number;
	guiDir?: string;
	nodeHeartbeatMs?: number;
	plane?: ControlPlane;
	nodes?: NodeRegistry;
	localIdentity?: { id: Protocol.NodeId; name: string; createdAt: string };
}

export type KerServer = Server & { plane: ControlPlane; ready: Promise<void>; shutdown(): Promise<void> };

interface RequestContext {
	manager: ControlPlane;
	subscribers: Map<ServerResponse, Protocol.NodeId | undefined>;
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
export function createServer(options: ServerOptions = {}): KerServer {
	const subscribers = new Map<ServerResponse, Protocol.NodeId | undefined>();
	const guiDir = options.guiDir ?? defaultGuiDir();
	const plane =
		options.plane ??
		new ControlPlane({
			store: new SessionStore({ baseDir: options.sessionDir }),
			catalogPath: options.catalogPath ?? defaultCatalogPath(),
			eventTailSize: options.eventTailSize ?? DEFAULT_EVENT_TAIL_SIZE,
			nodes: options.nodes,
			localIdentity: options.localIdentity,
		});
	const ready = Promise.resolve().then(() => plane.initialize());
	const manager = ready.then(() => plane);

	const server = createHttpServer((req, res) => {
		void handleRequest(manager, subscribers, guiDir, req, res);
	}) as KerServer;
	server.plane = plane;
	server.ready = ready;
	const closeNodeSockets = attachNodeSocket(server, plane, ready, options.nodeHeartbeatMs);
	server.shutdown = async () => {
		await ready;
		await closeNodeSockets();
		await plane.shutdown();
	};

	const heartbeat = setInterval(() => {
		for (const response of subscribers.keys()) {
			if (!response.destroyed) response.write(": hb\n\n");
		}
	}, HEARTBEAT_MS);
	heartbeat.unref();
	const stopNodeListener = plane.nodes.onChange((nodeId, connected) => {
		if (connected) return;
		for (const [response, subscribedNodeId] of subscribers) {
			if (subscribedNodeId === nodeId) response.end();
		}
	});
	server.once("close", () => {
		clearInterval(heartbeat);
		stopNodeListener();
	});
	return server;
}

async function handleRequest(
	managerPromise: Promise<ControlPlane>,
	subscribers: Map<ServerResponse, Protocol.NodeId | undefined>,
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
		if (match.route.upload && !hasContentType(req, match.route.upload)) {
			writeJson(res, 415, { code: "unsupported_media_type" });
			return;
		}
		if (match.route.upload && Number(req.headers["content-length"]) > MAX_ARCHIVE_BYTES) {
			writeJson(res, 413, { code: "payload_too_large" });
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
			if (error instanceof PayloadTooLargeError) {
				writeJson(res, 413, { code: "payload_too_large" });
				return;
			}
			if (error instanceof UnsupportedArchiveError) {
				writeJson(res, 400, { code: "unsupported_archive", message: error.message });
				return;
			}
			if (error instanceof InvalidArchiveError) {
				writeJson(res, 400, { code: "invalid_archive", message: error.message });
				return;
			}
			if (error instanceof WorkspaceConflictError) {
				writeJson(res, 409, { code: "workspace_conflict", message: error.message });
				return;
			}
			if (error instanceof ArchiveTooLargeError) {
				writeJson(res, 409, { code: "archive_too_large", message: error.message });
				return;
			}
			if (error instanceof Error && error.name === "InvalidCwdError") {
				writeJson(res, 400, { code: "invalid_cwd" });
				return;
			}
			if (error instanceof RemoteCallError && error.code === "invalid_cwd") {
				writeJson(res, 400, { code: "invalid_cwd" });
				return;
			}
			if (error instanceof NodeUnavailableError) {
				writeJson(res, 503, {
					code: "node_unavailable",
					message: error.nodeId ? (await managerPromise).nodeUnavailableMessage(error.nodeId) : "no node is connected",
				});
				return;
			}
			if (error instanceof NodeAmbiguousError) {
				writeJson(res, 409, { code: "node_ambiguous" });
				return;
			}
			if (error instanceof NodeNotFoundError) {
				writeJson(res, 404, { code: "node_not_found" });
				return;
			}
			if (error instanceof LocalNodeError) {
				writeJson(res, 409, { code: "node_local" });
				return;
			}
			if (error instanceof WorkspaceNotFoundError) {
				writeJson(res, 404, { code: "workspace_not_found" });
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
	listNodes: ({ manager, res }) => {
		const body: Protocol.ListNodesResponse = { nodes: manager.listNodes() };
		writeJson(res, 200, body);
	},
	createEnrollment: ({ manager, res, url }) => {
		writeJson(res, 201, manager.createEnrollment(url.origin));
	},
	revokeNode: ({ manager, res, params }) => {
		const node = manager.revokeNode(params.nodeId);
		if (!node) {
			writeJson(res, 404, { code: "node_not_found" });
			return;
		}
		writeJson(res, 200, node);
	},
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
	getProject: ({ manager, res, params }) => {
		const project = manager.getProject(params.projectId);
		if (project === "missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		writeJson(res, 200, project);
	},
	exportProject: async ({ manager, res, params }) => {
		const archive = await manager.exportProject(params.projectId);
		if (archive === "missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		res.writeHead(200, {
			"content-type": "application/zip",
			"content-disposition": `attachment; filename="${archive.fileName}"`,
			"cache-control": "no-store",
		});
		await pipeline(archive.stream, res);
	},
	importProject: async ({ manager, req, res, query }) => {
		writeJson(res, 201, await manager.importProject(limitArchive(req), query.nodeId?.toString()));
	},
	listWorkspaces: async ({ manager, res, params }) => {
		const workspaces = await manager.listWorkspaces(params.projectId);
		if (workspaces === "missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		const body: Protocol.ListWorkspacesResponse = { workspaces };
		writeJson(res, 200, body);
	},
	createWorkspace: async ({ manager, res, params, body }) => {
		try {
			const request = body as Protocol.WorkspaceRequest;
			const result = await manager.addWorkspace(params.projectId, request.path, request.nodeId);
			if (result === "missing") {
				writeJson(res, 404, { code: "project_not_found" });
				return;
			}
			writeJson(res, result.created ? 201 : 200, result.workspace);
		} catch (error) {
			if (!(error instanceof Error) || error.name !== "InvalidCwdError") throw error;
			writeJson(res, 400, { code: "invalid_workspace", message: error.message });
		}
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
		if (created === "project_missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		if (created === "workspace_missing") {
			writeJson(res, 409, { code: "workspace_missing" });
			return;
		}
		if (created === "ambiguous") {
			writeJson(res, 409, { code: "workspace_ambiguous" });
			return;
		}
		writeJson(res, 201, created);
	},
	createWorkspaceSession: async ({ manager, res, params }) => {
		const created = await manager.createWorkspaceSession(params.workspaceId);
		if (created === "workspace_missing") {
			writeJson(res, 409, { code: "workspace_missing" });
			return;
		}
		writeJson(res, 201, created);
	},
	listDocuments: ({ manager, res, params }) => {
		const documents = manager.listDocuments(params.projectId);
		if (documents === "missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		const body: Protocol.ListDocumentsResponse = { documents };
		writeJson(res, 200, body);
	},
	createDocument: ({ manager, res, params, body }) => {
		const created = manager.createDocument(params.projectId, body as Protocol.DocumentRequest);
		if (created === "missing") {
			writeJson(res, 404, { code: "project_not_found" });
			return;
		}
		writeJson(res, 201, created);
	},
	getDocument: ({ manager, res, params }) => {
		const document = manager.getDocument(params.documentId);
		if (document === "missing") {
			writeJson(res, 404, { code: "document_not_found" });
			return;
		}
		writeJson(res, 200, document);
	},
	updateDocument: ({ manager, res, params, body }) => {
		const document = manager.updateDocument(params.documentId, body as Protocol.DocumentRequest);
		if (document === "missing") {
			writeJson(res, 404, { code: "document_not_found" });
			return;
		}
		writeJson(res, 200, document);
	},
	deleteDocument: ({ manager, res, params }) => {
		const document = manager.deleteDocument(params.documentId);
		if (document === "missing") {
			writeJson(res, 404, { code: "document_not_found" });
			return;
		}
		writeJson(res, 200, document);
	},
	createSession: async ({ manager, res, body }) => {
		const request = body as Protocol.CreateSessionRequest;
		writeJson(res, 201, await manager.createSession(request.cwd, request.nodeId));
	},
	listSessions: async ({ manager, res, url }) => {
		const parameters = [...url.searchParams.entries()];
		if (parameters.length === 1 && parameters[0][0] === "scope" && parameters[0][1] === "all") {
			const body: Protocol.ListSessionsResponse = { sessions: manager.listSessions() };
			writeJson(res, 200, body);
			return;
		}
		const cwd = url.searchParams.get("cwd");
		const nodeId = url.searchParams.get("nodeId") ?? undefined;
		if (cwd === null || parameters.some(([name]) => name !== "cwd" && name !== "nodeId")) {
			writeJson(res, 400, { code: "invalid_scope" });
			return;
		}
		const resolved = await manager.resolveProjectRoot(cwd, nodeId);
		const body: Protocol.ListSessionsResponse = { sessions: manager.listSessions(resolved) };
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
		subscribers.set(res, manager.nodeIdForSession(sessionId));
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
	if (key === "createWorkspace") return "invalid_workspace";
	if (key === "createDocument" || key === "updateDocument") return "invalid_document";
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

async function* limitArchive(req: IncomingMessage): AsyncGenerator<Uint8Array> {
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_ARCHIVE_BYTES) throw new PayloadTooLargeError("Project archive exceeds 4 GiB");
		yield chunk;
	}
}

function hasContentType(req: IncomingMessage, expected: string): boolean {
	return req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function writeEvent(res: ServerResponse, envelope: Protocol.EventEnvelope): void {
	if (res.destroyed) return;
	res.write(`id: ${envelope.epoch}:${envelope.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`);
}

function writeJson(res: ServerResponse, status: number, body: object): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
