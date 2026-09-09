import { type TSchema, Type } from "@sinclair/typebox";
import {
	ClaimPairingRequest,
	CompactionAdmission,
	CompactRequest,
	CreateSessionRequest,
	Device,
	Document,
	DocumentRequest,
	Enrollment,
	EventEnvelope,
	Health,
	ImportResult,
	ListDevicesResponse,
	ListDocumentsResponse,
	ListNodesResponse,
	ListProjectsResponse,
	ListSessionsResponse,
	ListWorkspacesResponse,
	Node,
	Pairing,
	Project,
	PromptAdmission,
	PromptRequest,
	ReadableCatalogSession,
	SessionDescriptor,
	SessionSnapshot,
	TurnCancellationResult,
	Workspace,
	WorkspaceRequest,
} from "./index.ts";

export interface RouteDefinition {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	summary: string;
	description?: string;
	public?: true;
	kind?: "sse" | "download";
	upload?: "application/zip";
	params?: Record<string, TSchema>;
	query?: Record<string, { schema: TSchema; required?: true; coerce?: "integer" }>;
	body?: TSchema;
	responses: Record<number, TSchema>;
}

const openApiDocument = Type.Record(Type.String(), Type.Unknown());
const binary = Type.String({ format: "binary" });
const documentId = { documentId: Type.String({ minLength: 1 }) };
const projectId = { projectId: Type.String({ minLength: 1 }) };
const sessionId = { sessionId: Type.String({ minLength: 1 }) };
const turnId = { turnId: Type.String({ minLength: 1 }) };
const nodeId = { nodeId: Type.String({ minLength: 1 }) };

export const routes = {
	listDevices: {
		method: "GET",
		path: "/devices",
		summary: "List paired devices",
		responses: {
			200: ListDevicesResponse,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	createPairing: {
		method: "POST",
		path: "/devices/pairings",
		summary: "Create a one-time device pairing",
		responses: {
			201: Pairing,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			409: errorBody("auth_local"),
			500: errorBody("internal"),
		},
	},
	claimPairing: {
		method: "POST",
		path: "/devices/pairings/claim",
		summary: "Exchange a pairing code for a device credential",
		public: true,
		body: ClaimPairingRequest,
		responses: {
			201: Device,
			400: Type.Union([errorBody("invalid_pairing"), errorBody("invalid_json")]),
			403: errorBody("forbidden"),
			409: errorBody("auth_local"),
			410: errorBody("pairing_invalid"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: errorBody("internal"),
		},
	},
	revokeDevice: {
		method: "DELETE",
		path: "/devices/{deviceId}",
		summary: "Revoke a paired device",
		params: { deviceId: Type.String({ minLength: 1 }) },
		responses: {
			200: Device,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("device_not_found"),
			500: errorBody("internal"),
		},
	},
	listNodes: {
		method: "GET",
		path: "/nodes",
		summary: "List nodes",
		responses: {
			200: ListNodesResponse,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	createEnrollment: {
		method: "POST",
		path: "/nodes/enrollments",
		summary: "Create a one-time node enrollment",
		responses: {
			201: Enrollment,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	revokeNode: {
		method: "POST",
		path: "/nodes/{nodeId}/revoke",
		summary: "Revoke a node",
		params: nodeId,
		responses: {
			200: Node,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("node_not_found"),
			409: errorBody("node_local"),
			500: errorBody("internal"),
		},
	},
	health: {
		public: true,
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
		public: true,
		method: "GET",
		path: "/openapi.json",
		summary: "Read the API description",
		responses: {
			200: openApiDocument,
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	listProjects: {
		method: "GET",
		path: "/projects",
		summary: "List projects",
		description:
			"Every project with read-time aggregates: sessionCount counts all catalog sessions, lastActivityAt is the newest session updatedAt and null when the project has none.",
		responses: {
			200: ListProjectsResponse,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			500: errorBody("internal"),
		},
	},
	getProject: {
		method: "GET",
		path: "/projects/{projectId}",
		summary: "Read a project",
		params: projectId,
		responses: {
			200: Project,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("project_not_found"),
			500: errorBody("internal"),
		},
	},
	exportProject: {
		method: "GET",
		path: "/projects/{projectId}/export",
		summary: "Download a project archive",
		description:
			"Streams a zip: manifest.json first, then documents as Markdown files and session logs verbatim. See docs/archive-format.md.",
		kind: "download",
		params: projectId,
		responses: {
			200: binary,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("project_not_found"),
			409: errorBody("archive_too_large"),
			500: errorBody("internal"),
		},
	},
	importProject: {
		method: "POST",
		path: "/projects/import",
		summary: "Import a project archive",
		description:
			"Accepts a zip produced by the export route. IDs are kept; rows and logs that already exist are skipped; folders and sessions bind to this node.",
		upload: "application/zip",
		query: { nodeId: { schema: Type.String() } },
		responses: {
			201: ImportResult,
			400: Type.Union([errorBody("invalid_archive"), errorBody("unsupported_archive")]),
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("node_not_found"),
			409: errorBody("workspace_conflict"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: errorBody("internal"),
		},
	},
	listWorkspaces: {
		method: "GET",
		path: "/projects/{projectId}/workspaces",
		summary: "List a project's folders",
		description: "exists reports whether the folder is present on the node that owns it.",
		params: projectId,
		responses: {
			200: ListWorkspacesResponse,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: Type.Union([errorBody("project_not_found"), errorBody("node_not_found")]),
			500: errorBody("internal"),
		},
	},
	createWorkspace: {
		method: "POST",
		path: "/projects/{projectId}/workspaces",
		summary: "Add a folder to a project",
		description:
			"The path must be a directory on this node; it is canonicalized and walked up to its git root. Responds 200 with the existing row when this project already has that folder.",
		params: projectId,
		body: WorkspaceRequest,
		responses: {
			200: Workspace,
			201: Workspace,
			400: Type.Union([errorBody("invalid_workspace"), errorBody("invalid_json")]),
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("project_not_found"),
			409: Type.Union([errorBody("workspace_conflict"), errorBody("node_ambiguous")]),
			503: errorBody("node_unavailable"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: errorBody("internal"),
		},
	},
	listProjectSessions: {
		method: "GET",
		path: "/projects/{projectId}/sessions",
		summary: "List a project's sessions",
		params: projectId,
		responses: {
			200: ListSessionsResponse,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("project_not_found"),
			500: errorBody("internal"),
		},
	},
	createProjectSession: {
		method: "POST",
		path: "/projects/{projectId}/sessions",
		summary: "Create a session in a project",
		description:
			"Creates a session in the project's sole existing workspace on this node. Responds 409 when none or more than one exist.",
		params: projectId,
		responses: {
			201: ReadableCatalogSession,
			400: errorBody("invalid_cwd"),
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("project_not_found"),
			409: Type.Union([errorBody("workspace_ambiguous"), errorBody("workspace_missing")]),
			503: errorBody("node_unavailable"),
			500: errorBody("internal"),
		},
	},
	createWorkspaceSession: {
		method: "POST",
		path: "/workspaces/{workspaceId}/sessions",
		summary: "Create a session in a folder",
		params: { workspaceId: Type.String({ minLength: 1 }) },
		responses: {
			201: ReadableCatalogSession,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("workspace_not_found"),
			409: errorBody("workspace_missing"),
			503: errorBody("node_unavailable"),
			500: errorBody("internal"),
		},
	},
	listDocuments: {
		method: "GET",
		path: "/projects/{projectId}/documents",
		summary: "List a project's documents",
		description: "Summaries ordered by updatedAt descending; fetch a document for its body.",
		params: projectId,
		responses: {
			200: ListDocumentsResponse,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("project_not_found"),
			500: errorBody("internal"),
		},
	},
	createDocument: {
		method: "POST",
		path: "/projects/{projectId}/documents",
		summary: "Create a document in a project",
		params: projectId,
		body: DocumentRequest,
		responses: {
			201: Document,
			400: Type.Union([errorBody("invalid_document"), errorBody("invalid_json")]),
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("project_not_found"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: errorBody("internal"),
		},
	},
	getDocument: {
		method: "GET",
		path: "/documents/{documentId}",
		summary: "Read a document",
		params: documentId,
		responses: {
			200: Document,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("document_not_found"),
			500: errorBody("internal"),
		},
	},
	updateDocument: {
		method: "PUT",
		path: "/documents/{documentId}",
		summary: "Replace a document's title and body",
		description: "Last write wins; there is no revision check.",
		params: documentId,
		body: DocumentRequest,
		responses: {
			200: Document,
			400: Type.Union([errorBody("invalid_document"), errorBody("invalid_json")]),
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("document_not_found"),
			413: errorBody("payload_too_large"),
			415: errorBody("unsupported_media_type"),
			500: errorBody("internal"),
		},
	},
	deleteDocument: {
		method: "DELETE",
		path: "/documents/{documentId}",
		summary: "Delete a document",
		description: "Responds with the deleted document.",
		params: documentId,
		responses: {
			200: Document,
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("document_not_found"),
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
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("node_not_found"),
			409: errorBody("node_ambiguous"),
			503: errorBody("node_unavailable"),
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
			nodeId: { schema: Type.String() },
			scope: { schema: Type.Literal("all") },
		},
		responses: {
			200: ListSessionsResponse,
			400: Type.Union([errorBody("invalid_scope"), errorBody("invalid_cwd")]),
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			409: errorBody("node_ambiguous"),
			503: errorBody("node_unavailable"),
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
			401: errorBody("unauthorized"),
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
			401: errorBody("unauthorized"),
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
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			409: errorBody("context_exhausted"),
			503: errorBody("node_unavailable"),
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
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			503: errorBody("node_unavailable"),
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
			401: errorBody("unauthorized"),
			403: errorBody("forbidden"),
			404: errorBody("session_not_found"),
			409: errorBody("turn_unavailable"),
			503: errorBody("node_unavailable"),
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
