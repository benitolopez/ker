import { type TSchema, Type } from "@sinclair/typebox";
import {
	CompactionAdmission,
	CompactRequest,
	CreateSessionRequest,
	EventEnvelope,
	Health,
	ListSessionsResponse,
	PromptAdmission,
	PromptRequest,
	SessionDescriptor,
	SessionSnapshot,
	TurnCancellationResult,
} from "./index.ts";

export interface RouteDefinition {
	method: "GET" | "POST";
	path: string;
	summary: string;
	description?: string;
	kind?: "sse";
	params?: Record<string, TSchema>;
	query?: Record<string, { schema: TSchema; required?: true; coerce?: "integer" }>;
	body?: TSchema;
	responses: Record<number, TSchema>;
}

const openApiDocument = Type.Record(Type.String(), Type.Unknown());
const sessionId = { sessionId: Type.String({ minLength: 1 }) };
const turnId = { turnId: Type.String({ minLength: 1 }) };

export const routes = {
	health: {
		method: "GET",
		path: "/health",
		summary: "Inspect daemon health",
		responses: {
			200: Health,
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	openapi: {
		method: "GET",
		path: "/openapi.json",
		summary: "Read the API description",
		responses: {
			200: openApiDocument,
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	createSession: {
		method: "POST",
		path: "/sessions",
		summary: "Create a session",
		body: CreateSessionRequest,
		responses: {
			201: SessionDescriptor,
			400: Type.Union([errorBody("invalid_cwd"), errorBody("invalid_json")]),
			403: errorBody("forbidden"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: errorBody("internal"),
		},
	},
	listSessions: {
		method: "GET",
		path: "/sessions",
		summary: "List sessions",
		description:
			"Supply exactly one scope: cwd lists sessions in that project, while scope=all lists every local session.",
		query: {
			cwd: { schema: Type.String() },
			scope: { schema: Type.Literal("all") },
		},
		responses: {
			200: ListSessionsResponse,
			400: Type.Union([errorBody("invalid_scope"), errorBody("invalid_cwd")]),
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	snapshot: {
		method: "GET",
		path: "/sessions/{sessionId}",
		summary: "Read a session snapshot",
		params: sessionId,
		responses: {
			200: SessionSnapshot,
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			500: Type.Union([errorBody("session_unreadable"), errorBody("internal")]),
		},
	},
	events: {
		method: "GET",
		path: "/sessions/{sessionId}/events",
		summary: "Subscribe to session events",
		description:
			"Streams Server-Sent Events after the supplied cursor. Each event uses id: epoch:sequence and a data line containing an EventEnvelope; comment frames are heartbeats. Reconnect with the last received cursor. A 410 response requires fetching a fresh snapshot and reconnecting from its cursor. Subscribe before admitting work to avoid missing an event between the snapshot and admission.",
		kind: "sse",
		params: sessionId,
		query: {
			epoch: { schema: Type.String({ minLength: 1 }), required: true },
			sequence: {
				schema: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
				required: true,
				coerce: "integer",
			},
		},
		responses: {
			200: EventEnvelope,
			400: errorBody("invalid_cursor"),
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			410: errorBody("resync_required"),
			500: Type.Union([errorBody("session_unreadable"), errorBody("internal")]),
		},
	},
	prompt: {
		method: "POST",
		path: "/sessions/{sessionId}/prompts",
		summary: "Submit a prompt",
		params: sessionId,
		body: PromptRequest,
		responses: {
			202: PromptAdmission,
			400: Type.Union([errorBody("invalid_prompt"), errorBody("invalid_json")]),
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			409: errorBody("context_exhausted"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: Type.Union([errorBody("session_unreadable"), errorBody("internal")]),
		},
	},
	compact: {
		method: "POST",
		path: "/sessions/{sessionId}/compact",
		summary: "Compact a session",
		params: sessionId,
		body: CompactRequest,
		responses: {
			202: CompactionAdmission,
			400: Type.Union([errorBody("invalid_compaction"), errorBody("invalid_json")]),
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: Type.Union([errorBody("session_unreadable"), errorBody("internal")]),
		},
	},
	cancel: {
		method: "POST",
		path: "/sessions/{sessionId}/turns/{turnId}/cancel",
		summary: "Cancel a turn",
		params: { ...sessionId, ...turnId },
		responses: {
			200: TurnCancellationResult,
			202: TurnCancellationResult,
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			409: errorBody("turn_unavailable"),
			500: Type.Union([errorBody("session_unreadable"), errorBody("internal")]),
		},
	},
} satisfies Record<string, RouteDefinition>;

export type RouteKey = keyof typeof routes;

function errorBody<const Code extends string>(code: Code) {
	return Type.Object(
		{
			code: Type.Literal(code),
			message: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	);
}
