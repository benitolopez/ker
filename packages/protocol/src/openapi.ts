import type { TSchema } from "@sinclair/typebox";
import * as Protocol from "./index.ts";
import { type RouteDefinition, type RouteKey, routes } from "./routes.ts";

export const components = {
	Actor: Protocol.Actor,
	AuthMode: Protocol.AuthMode,
	Device: Protocol.Device,
	ListDevicesResponse: Protocol.ListDevicesResponse,
	Pairing: Protocol.Pairing,
	ClaimPairingRequest: Protocol.ClaimPairingRequest,

	ModelRole: Protocol.ModelRole,
	AdmissionStatus: Protocol.AdmissionStatus,
	CancellationStatus: Protocol.CancellationStatus,
	CompactionSource: Protocol.CompactionSource,
	TurnTerminalReason: Protocol.TurnTerminalReason,
	AssistantTerminalReason: Protocol.AssistantTerminalReason,
	Provider: Protocol.Provider,
	ReasoningEffort: Protocol.ReasoningEffort,
	Model: Protocol.Model,
	Usage: Protocol.Usage,
	DiffDetails: Protocol.DiffDetails,
	ToolDetails: Protocol.ToolDetails,
	SessionUsage: Protocol.SessionUsage,
	SessionDescriptor: Protocol.SessionDescriptor,
	CreateSessionRequest: Protocol.CreateSessionRequest,
	Node: Protocol.Node,
	ListNodesResponse: Protocol.ListNodesResponse,
	Enrollment: Protocol.Enrollment,
	ReadableCatalogSession: Protocol.ReadableCatalogSession,
	UnreadableCatalogSession: Protocol.UnreadableCatalogSession,
	CatalogSession: Protocol.CatalogSession,
	ListSessionsResponse: Protocol.ListSessionsResponse,
	Project: Protocol.Project,
	ListProjectsResponse: Protocol.ListProjectsResponse,
	Workspace: Protocol.Workspace,
	ListWorkspacesResponse: Protocol.ListWorkspacesResponse,
	WorkspaceRequest: Protocol.WorkspaceRequest,
	Document: Protocol.Document,
	DocumentSummary: Protocol.DocumentSummary,
	ListDocumentsResponse: Protocol.ListDocumentsResponse,
	DocumentRequest: Protocol.DocumentRequest,
	ImportResult: Protocol.ImportResult,
	ArchiveNode: Protocol.ArchiveNode,
	ArchiveWorkspace: Protocol.ArchiveWorkspace,
	ArchiveSession: Protocol.ArchiveSession,
	ArchiveDocument: Protocol.ArchiveDocument,
	ArchiveManifest: Protocol.ArchiveManifest,
	QueueItemBase: Protocol.QueueItemBase,
	PromptQueueItem: Protocol.PromptQueueItem,
	CompactionQueueItem: Protocol.CompactionQueueItem,
	QueueItem: Protocol.QueueItem,
	QueueSnapshot: Protocol.QueueSnapshot,
	Cursor: Protocol.Cursor,
	AssistantMessage: Protocol.AssistantMessage,
	ActiveAssistantMessage: Protocol.ActiveAssistantMessage,
	TurnSnapshot: Protocol.TurnSnapshot,
	ConversationEntry: Protocol.ConversationEntry,
	CompactionFailure: Protocol.CompactionFailure,
	Identity: Protocol.Identity,
	SessionSnapshot: Protocol.SessionSnapshot,
	MessageSubmittedEvent: Protocol.MessageSubmittedEvent,
	CompactionSubmittedEvent: Protocol.CompactionSubmittedEvent,
	CompactedEvent: Protocol.CompactedEvent,
	CompactionSkippedEvent: Protocol.CompactionSkippedEvent,
	PrunedEvent: Protocol.PrunedEvent,
	MessageDeliveredEvent: Protocol.MessageDeliveredEvent,
	MessageUndeliveredEvent: Protocol.MessageUndeliveredEvent,
	TurnCancelRequestedEvent: Protocol.TurnCancelRequestedEvent,
	MessageDeltaEvent: Protocol.MessageDeltaEvent,
	ReasoningDeltaEvent: Protocol.ReasoningDeltaEvent,
	AssistantMessageCompletedEvent: Protocol.AssistantMessageCompletedEvent,
	UsageEvent: Protocol.UsageEvent,
	ErrorCode: Protocol.ErrorCode,
	ErrorEvent: Protocol.ErrorEvent,
	RetryEvent: Protocol.RetryEvent,
	AuthEvent: Protocol.AuthEvent,
	EndEvent: Protocol.EndEvent,
	AbortedEvent: Protocol.AbortedEvent,
	InterruptedEvent: Protocol.InterruptedEvent,
	CancelledEvent: Protocol.CancelledEvent,
	TurnTerminalEvent: Protocol.TurnTerminalEvent,
	QueueChangedEvent: Protocol.QueueChangedEvent,
	ToolCallEvent: Protocol.ToolCallEvent,
	ToolResultEvent: Protocol.ToolResultEvent,
	Event: Protocol.Event,
	EventEnvelope: Protocol.EventEnvelope,
	PromptRequest: Protocol.PromptRequest,
	PromptAdmission: Protocol.PromptAdmission,
	CompactRequest: Protocol.CompactRequest,
	CompactionAdmission: Protocol.CompactionAdmission,
	TurnCancellationResult: Protocol.TurnCancellationResult,
	Health: Protocol.Health,
	ErrorBody: Protocol.ErrorBody,
} satisfies Record<string, TSchema>;

const componentNames = new Map(Object.entries(components).map(([name, schema]) => [JSON.stringify(schema), name]));

export function createOpenApiDocument(): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const [key, route] of Object.entries(routes) as Array<[RouteKey, RouteDefinition]>) {
		paths[route.path] ??= {};
		paths[route.path][route.method.toLowerCase()] = createOperation(key, route);
	}
	return {
		openapi: "3.1.0",
		info: { title: "ker", version: Protocol.PROTOCOL_VERSION },
		paths,
		components: {
			schemas: Object.fromEntries(
				Object.entries(components).map(([name, schema]) => [name, replaceComponents(schema, schema)]),
			),
		},
	};
}

export function createOpenApiJson(): string {
	return `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
}

function createOperation(key: RouteKey, route: RouteDefinition): Record<string, unknown> {
	const parameters = [
		...Object.entries(route.params ?? {}).map(([name, schema]) => ({
			name,
			in: "path",
			required: true,
			schema: replaceComponents(schema),
		})),
		...Object.entries(route.query ?? {}).map(([name, parameter]) => ({
			name,
			in: "query",
			required: parameter.required === true,
			schema: replaceComponents(parameter.schema),
		})),
	];
	return {
		operationId: key,
		summary: route.summary,
		...(route.description === undefined ? {} : { description: route.description }),
		...(parameters.length === 0 ? {} : { parameters }),
		...(route.upload === undefined
			? route.body === undefined
				? {}
				: {
						requestBody: {
							required: true,
							content: { "application/json": { schema: replaceComponents(route.body) } },
						},
					}
			: {
					requestBody: {
						required: true,
						content: { [route.upload]: { schema: { type: "string", format: "binary" } } },
					},
				}),
		responses: Object.fromEntries(
			Object.entries(route.responses).map(([status, schema]) => [
				status,
				{
					description: Number(status) >= 400 ? "Error" : "Success",
					content: {
						[responseContentType(route, status)]: {
							schema: replaceComponents(schema),
						},
					},
				},
			]),
		),
	};
}

function responseContentType(route: RouteDefinition, status: string): string {
	if (status !== "200") return "application/json";
	if (route.kind === "sse") return "text/event-stream";
	if (route.kind === "download") return "application/zip";
	return "application/json";
}

// TypeBox clones schemas wrapped in Type.Optional, so component matching uses their JSON form.
function replaceComponents(value: unknown, root?: TSchema): unknown {
	if (value !== root && typeof value === "object" && value !== null) {
		const componentName = componentNames.get(JSON.stringify(value));
		if (componentName) return { $ref: `#/components/schemas/${componentName}` };
	}
	if (Array.isArray(value)) return value.map((item) => replaceComponents(item, root));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceComponents(item, root)]));
}
