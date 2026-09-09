import { createHash } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";

// Wire contract between the daemon and its clients.

export const Actor = Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("process")]);
export type Actor = Static<typeof Actor>;

export const ModelRole = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]);
export type ModelRole = Static<typeof ModelRole>;

export type SessionId = string;
export type TurnId = string;
export type MessageId = string;
export type QueueItemId = string;
export type ProjectId = string;
export type DocumentId = string;
export type WorkspaceId = string;
export type NodeId = string;
export type DeviceId = string;

export const PROJECT_KEY_PATTERN = /^[a-f0-9]{64}$/;

export function projectKey(projectRoot: string): string {
	return createHash("sha256").update(projectRoot).digest("hex");
}

export const AdmissionStatus = Type.Union([Type.Literal("running"), Type.Literal("waiting")]);
export type AdmissionStatus = Static<typeof AdmissionStatus>;

export const CancellationStatus = Type.Union([
	Type.Literal("cancelling"),
	Type.Literal("cancelled"),
	Type.Literal("aborted"),
]);
export type CancellationStatus = Static<typeof CancellationStatus>;

export const CompactionSource = Type.Union([Type.Literal("auto"), Type.Literal("manual")]);
export type CompactionSource = Static<typeof CompactionSource>;

export const TurnTerminalReason = Type.Union([
	Type.Literal("completed"),
	Type.Literal("aborted"),
	Type.Literal("error"),
	Type.Literal("interrupted"),
	Type.Literal("cancelled"),
	Type.Literal("expired"),
]);
export type TurnTerminalReason = Static<typeof TurnTerminalReason>;

export const AssistantTerminalReason = Type.Union([
	Type.Literal("completed"),
	Type.Literal("length"),
	Type.Literal("aborted"),
	Type.Literal("error"),
]);
export type AssistantTerminalReason = Static<typeof AssistantTerminalReason>;

export const Provider = Type.Union([Type.Literal("openai"), Type.Literal("openai-codex")]);
export type Provider = Static<typeof Provider>;

export const ReasoningEffort = Type.Union([
	Type.Literal("none"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);
export type ReasoningEffort = Static<typeof ReasoningEffort>;

export const Model = Type.Object(
	{
		provider: Provider,
		id: Type.String(),
		contextWindow: Type.Optional(Type.Number()),
		maxOutputTokens: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);
export type Model = Static<typeof Model>;

export const Usage = Type.Object(
	{
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		reasoning: Type.Optional(Type.Number()),
		total: Type.Number(),
	},
	{ additionalProperties: false },
);
export type Usage = Static<typeof Usage>;

export const DiffDetails = Type.Object(
	{
		kind: Type.Literal("diff"),
		path: Type.String(),
		patch: Type.String(),
	},
	{ additionalProperties: false },
);
export type DiffDetails = Static<typeof DiffDetails>;

export const ToolDetails = Type.Union([DiffDetails]);
export type ToolDetails = Static<typeof ToolDetails>;

export const SessionUsage = Type.Object(
	{
		contextTokens: Type.Number(),
		cumulative: Usage,
	},
	{ additionalProperties: false },
);
export type SessionUsage = Static<typeof SessionUsage>;

export const SessionDescriptor = Type.Object(
	{
		id: Type.String(),
		nodeId: Type.String(),
		cwd: Type.String(),
		projectRoot: Type.String(),
		createdAt: Type.String(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);
export type SessionDescriptor = Static<typeof SessionDescriptor>;

export const CreateSessionRequest = Type.Object(
	{ cwd: Type.String(), nodeId: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
export type CreateSessionRequest = Static<typeof CreateSessionRequest>;

export const AuthMode = Type.Union([Type.Literal("local"), Type.Literal("device")]);
export type AuthMode = Static<typeof AuthMode>;

export const Device = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		createdAt: Type.String(),
		lastSeenAt: Type.Union([Type.String(), Type.Null()]),
		current: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type Device = Static<typeof Device>;

export const ListDevicesResponse = Type.Object({ devices: Type.Array(Device) }, { additionalProperties: false });
export type ListDevicesResponse = Static<typeof ListDevicesResponse>;

export const Pairing = Type.Object(
	{ code: Type.String(), expiresAt: Type.String(), url: Type.String() },
	{ additionalProperties: false },
);
export type Pairing = Static<typeof Pairing>;

export const ClaimPairingRequest = Type.Object(
	{ code: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1, maxLength: 80 }) },
	{ additionalProperties: false },
);
export type ClaimPairingRequest = Static<typeof ClaimPairingRequest>;

export const Node = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		createdAt: Type.String(),
		enrolledAt: Type.Union([Type.String(), Type.Null()]),
		revokedAt: Type.Union([Type.String(), Type.Null()]),
		lastSeenAt: Type.Union([Type.String(), Type.Null()]),
		local: Type.Boolean(),
		connected: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type Node = Static<typeof Node>;

export const ListNodesResponse = Type.Object({ nodes: Type.Array(Node) }, { additionalProperties: false });
export type ListNodesResponse = Static<typeof ListNodesResponse>;

export const Enrollment = Type.Object(
	{
		token: Type.String(),
		expiresAt: Type.String(),
		command: Type.String(),
	},
	{ additionalProperties: false },
);
export type Enrollment = Static<typeof Enrollment>;

export const ReadableCatalogSession = Type.Object(
	{
		status: Type.Union([Type.Literal("idle"), Type.Literal("busy")]),
		id: Type.String(),
		cwd: Type.String(),
		projectId: Type.String(),
		projectName: Type.String(),
		workspaceId: Type.String(),
		nodeId: Type.String(),
		nodeName: Type.String(),
		title: Type.Union([Type.String(), Type.Null()]),
		createdAt: Type.String(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);
export type ReadableCatalogSession = Static<typeof ReadableCatalogSession>;

// Existing catalog metadata survives when a session log cannot be read.
export const UnreadableCatalogSession = Type.Object(
	{
		status: Type.Literal("unreadable"),
		id: Type.String(),
		error: Type.String(),
		cwd: Type.Optional(Type.String()),
		projectId: Type.Optional(Type.String()),
		projectName: Type.Optional(Type.String()),
		workspaceId: Type.Optional(Type.String()),
		nodeId: Type.Optional(Type.String()),
		nodeName: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		createdAt: Type.Optional(Type.String()),
		updatedAt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type UnreadableCatalogSession = Static<typeof UnreadableCatalogSession>;

export const CatalogSession = Type.Union([ReadableCatalogSession, UnreadableCatalogSession]);
export type CatalogSession = Static<typeof CatalogSession>;

export const ListSessionsResponse = Type.Object(
	{ sessions: Type.Array(CatalogSession) },
	{ additionalProperties: false },
);
export type ListSessionsResponse = Static<typeof ListSessionsResponse>;

export const Project = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		createdAt: Type.String(),
		sessionCount: Type.Number(),
		lastActivityAt: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false },
);
export type Project = Static<typeof Project>;

export const ListProjectsResponse = Type.Object({ projects: Type.Array(Project) }, { additionalProperties: false });
export type ListProjectsResponse = Static<typeof ListProjectsResponse>;

export const Workspace = Type.Object(
	{
		id: Type.String(),
		projectId: Type.String(),
		nodeId: Type.String(),
		nodeName: Type.String(),
		nodeConnected: Type.Boolean(),
		rootPath: Type.String(),
		gitRemote: Type.Union([Type.String(), Type.Null()]),
		createdAt: Type.String(),
		exists: Type.Union([Type.Boolean(), Type.Null()]),
	},
	{ additionalProperties: false },
);
export type Workspace = Static<typeof Workspace>;

export const ListWorkspacesResponse = Type.Object(
	{ workspaces: Type.Array(Workspace) },
	{ additionalProperties: false },
);
export type ListWorkspacesResponse = Static<typeof ListWorkspacesResponse>;

export const WorkspaceRequest = Type.Object(
	{ path: Type.String({ minLength: 1 }), nodeId: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
export type WorkspaceRequest = Static<typeof WorkspaceRequest>;

export const Document = Type.Object(
	{
		id: Type.String(),
		projectId: Type.String(),
		title: Type.String(),
		body: Type.String(),
		createdAt: Type.String(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);
export type Document = Static<typeof Document>;

export const DocumentSummary = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		createdAt: Type.String(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);
export type DocumentSummary = Static<typeof DocumentSummary>;

export const ListDocumentsResponse = Type.Object(
	{ documents: Type.Array(DocumentSummary) },
	{ additionalProperties: false },
);
export type ListDocumentsResponse = Static<typeof ListDocumentsResponse>;

export const DocumentRequest = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
		body: Type.String(),
	},
	{ additionalProperties: false },
);
export type DocumentRequest = Static<typeof DocumentRequest>;

export const ImportResult = Type.Object(
	{
		project: Project,
		created: Type.Boolean(),
		workspaces: Type.Object({ created: Type.Number(), reused: Type.Number() }, { additionalProperties: false }),
		documents: Type.Object({ imported: Type.Number(), skipped: Type.Number() }, { additionalProperties: false }),
		sessions: Type.Object(
			{
				imported: Type.Number(),
				skipped: Type.Number(),
				unreadable: Type.Number(),
				missing: Type.Number(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type ImportResult = Static<typeof ImportResult>;

export const ARCHIVE_FORMAT = 1 as const;

export const ArchiveNode = Type.Object(
	{ id: Type.String(), name: Type.String(), createdAt: Type.String() },
	{ additionalProperties: false },
);
export type ArchiveNode = Static<typeof ArchiveNode>;

export const ArchiveWorkspace = Type.Object(
	{
		id: Type.String(),
		nodeId: Type.String(),
		rootPath: Type.String(),
		gitRemote: Type.Union([Type.String(), Type.Null()]),
		createdAt: Type.String(),
	},
	{ additionalProperties: false },
);
export type ArchiveWorkspace = Static<typeof ArchiveWorkspace>;

export const ArchiveSession = Type.Object(
	{
		id: Type.String({ pattern: "^[0-9a-f-]{36}$" }),
		projectKey: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		workspaceId: Type.Union([Type.String(), Type.Null()]),
		nodeId: Type.Union([Type.String(), Type.Null()]),
		cwd: Type.Union([Type.String(), Type.Null()]),
		title: Type.Union([Type.String(), Type.Null()]),
		status: Type.Union([Type.Literal("idle"), Type.Literal("busy"), Type.Literal("unreadable")]),
		error: Type.Union([Type.String(), Type.Null()]),
		createdAt: Type.Union([Type.String(), Type.Null()]),
		updatedAt: Type.Union([Type.String(), Type.Null()]),
		file: Type.Union([Type.String({ pattern: "^sessions/[0-9a-f-]{36}/session\\.jsonl$" }), Type.Null()]),
	},
	{ additionalProperties: false },
);
export type ArchiveSession = Static<typeof ArchiveSession>;

export const ArchiveDocument = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		createdAt: Type.String(),
		updatedAt: Type.String(),
		file: Type.String({ pattern: "^documents/[a-z0-9-]{1,60}-[0-9a-f]{8,32}\\.md$" }),
	},
	{ additionalProperties: false },
);
export type ArchiveDocument = Static<typeof ArchiveDocument>;

export const ArchiveManifest = Type.Object(
	{
		format: Type.Integer({ minimum: 1 }),
		exportedAt: Type.String(),
		versions: Type.Object(
			{ protocol: Type.String(), store: Type.Integer(), catalog: Type.Integer() },
			{ additionalProperties: false },
		),
		project: Type.Object(
			{ id: Type.String(), name: Type.String(), createdAt: Type.String() },
			{ additionalProperties: false },
		),
		nodes: Type.Array(ArchiveNode),
		workspaces: Type.Array(ArchiveWorkspace),
		sessions: Type.Array(ArchiveSession),
		documents: Type.Array(ArchiveDocument),
	},
	{ additionalProperties: false },
);
export type ArchiveManifest = Static<typeof ArchiveManifest>;

const queueItemFields = {
	id: Type.String(),
	turnId: Type.String(),
	state: Type.Union([Type.Literal("running"), Type.Literal("cancelling"), Type.Literal("waiting")]),
	submittedAt: Type.String(),
};

export const QueueItemBase = Type.Object(queueItemFields, { additionalProperties: false });
export type QueueItemBase = Static<typeof QueueItemBase>;

export const PromptQueueItem = Type.Object(
	{
		...queueItemFields,
		kind: Type.Literal("prompt"),
		messageId: Type.String(),
		text: Type.String(),
	},
	{ additionalProperties: false },
);
export type PromptQueueItem = Static<typeof PromptQueueItem>;

export const CompactionQueueItem = Type.Object(
	{
		...queueItemFields,
		kind: Type.Literal("compaction"),
		source: CompactionSource,
		instructions: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type CompactionQueueItem = Static<typeof CompactionQueueItem>;

export const QueueItem = Type.Union([PromptQueueItem, CompactionQueueItem]);
export type QueueItem = Static<typeof QueueItem>;

export const QueueSnapshot = Type.Object(
	{
		revision: Type.Number(),
		running: Type.Optional(QueueItem),
		waiting: Type.Array(QueueItem),
	},
	{ additionalProperties: false },
);
export type QueueSnapshot = Static<typeof QueueSnapshot>;

export const Cursor = Type.Object(
	{
		epoch: Type.String(),
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);
export type Cursor = Static<typeof Cursor>;

export const AssistantMessage = Type.Object(
	{
		id: Type.String(),
		turnId: Type.String(),
		text: Type.String(),
		reason: AssistantTerminalReason,
	},
	{ additionalProperties: false },
);
export type AssistantMessage = Static<typeof AssistantMessage>;

export const ActiveAssistantMessage = Type.Object(
	{
		id: Type.String(),
		turnId: Type.String(),
		text: Type.String(),
	},
	{ additionalProperties: false },
);
export type ActiveAssistantMessage = Static<typeof ActiveAssistantMessage>;

export const TurnSnapshot = Type.Object(
	{
		id: Type.String(),
		status: Type.Union([
			Type.Literal("running"),
			Type.Literal("cancelling"),
			Type.Literal("waiting"),
			TurnTerminalReason,
		]),
	},
	{ additionalProperties: false },
);
export type TurnSnapshot = Static<typeof TurnSnapshot>;

const conversationEntryFields = {
	id: Type.String(),
	parentId: Type.Union([Type.String(), Type.Null()]),
	turnId: Type.String(),
	messageId: Type.Optional(Type.String()),
};

const UserConversationEntry = Type.Object(
	{
		...conversationEntryFields,
		role: Type.Union([Type.Literal("user"), Type.Literal("developer")]),
		content: Type.String(),
	},
	{ additionalProperties: false },
);

const AssistantConversationEntry = Type.Object(
	{
		...conversationEntryFields,
		role: Type.Literal("assistant"),
		content: Type.String(),
		reasoningSummary: Type.Optional(Type.String()),
		toolCalls: Type.Array(
			Type.Object(
				{ id: Type.String(), name: Type.String(), arguments: Type.String() },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const ToolConversationEntry = Type.Object(
	{
		...conversationEntryFields,
		role: Type.Literal("tool"),
		toolCallId: Type.String(),
		content: Type.String(),
		status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
		details: Type.Optional(ToolDetails),
	},
	{ additionalProperties: false },
);

const CompactionConversationEntry = Type.Object(
	{
		...conversationEntryFields,
		role: Type.Literal("compaction"),
		summary: Type.String(),
		tokensBefore: Type.Number(),
		tokensAfter: Type.Number(),
		firstKeptEntryId: Type.String(),
	},
	{ additionalProperties: false },
);

export const ConversationEntry = Type.Union([
	UserConversationEntry,
	AssistantConversationEntry,
	ToolConversationEntry,
	CompactionConversationEntry,
]);
export type ConversationEntry = Static<typeof ConversationEntry>;

// Clients surface the latest automatic compaction failure until a later compaction clears it.
export const CompactionFailure = Type.Object(
	{
		turnId: Type.String(),
		message: Type.String(),
	},
	{ additionalProperties: false },
);
export type CompactionFailure = Static<typeof CompactionFailure>;

export const Identity = Type.Union([
	Type.Object({ kind: Type.Literal("apikey") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("oauth"), accountId: Type.String() }, { additionalProperties: false }),
]);
export type Identity = Static<typeof Identity>;

export const SessionSnapshot = Type.Object(
	{
		session: SessionDescriptor,
		identity: Type.Optional(Identity),
		model: Type.Optional(Model),
		usage: SessionUsage,
		compactionFailure: Type.Optional(CompactionFailure),
		entries: Type.Array(ConversationEntry),
		messages: Type.Array(AssistantMessage),
		active: Type.Optional(ActiveAssistantMessage),
		turns: Type.Array(TurnSnapshot),
		queue: QueueSnapshot,
		cursor: Cursor,
	},
	{ additionalProperties: false },
);
export type SessionSnapshot = Static<typeof SessionSnapshot>;

export interface EventBase {
	actor: Actor;
	sessionId: SessionId;
	type: string;
}

export interface TurnEventBase extends EventBase {
	turnId: TurnId;
}

const eventFields = { sessionId: Type.String() };
const turnEventFields = { ...eventFields, turnId: Type.String() };

export const MessageSubmittedEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("human"),
		type: Type.Literal("message_submitted"),
		messageId: Type.String(),
		queueItemId: Type.String(),
		text: Type.String(),
		admission: AdmissionStatus,
	},
	{ additionalProperties: false },
);
export type MessageSubmittedEvent = Static<typeof MessageSubmittedEvent>;

export const CompactionSubmittedEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Union([Type.Literal("human"), Type.Literal("process")]),
		type: Type.Literal("compaction_submitted"),
		queueItemId: Type.String(),
		source: CompactionSource,
		instructions: Type.Optional(Type.String()),
		admission: AdmissionStatus,
	},
	{ additionalProperties: false },
);
export type CompactionSubmittedEvent = Static<typeof CompactionSubmittedEvent>;

export const CompactedEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("compacted"),
		summary: Type.String(),
		tokensBefore: Type.Number(),
		tokensAfter: Type.Number(),
		firstKeptEntryId: Type.String(),
	},
	{ additionalProperties: false },
);
export type CompactedEvent = Static<typeof CompactedEvent>;

export const CompactionSkippedEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("compaction_skipped"),
		reason: Type.Literal("nothing_to_compact"),
	},
	{ additionalProperties: false },
);
export type CompactionSkippedEvent = Static<typeof CompactionSkippedEvent>;

export const PrunedEvent = Type.Object(
	{
		...eventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("pruned"),
		toolCallIds: Type.Array(Type.String()),
		tokensBefore: Type.Number(),
		tokensAfter: Type.Number(),
	},
	{ additionalProperties: false },
);
export type PrunedEvent = Static<typeof PrunedEvent>;

export const MessageDeliveredEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("human"),
		modelRole: Type.Literal("user"),
		type: Type.Literal("message_delivered"),
		messageId: Type.String(),
		text: Type.String(),
	},
	{ additionalProperties: false },
);
export type MessageDeliveredEvent = Static<typeof MessageDeliveredEvent>;

export const MessageUndeliveredEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("message_undelivered"),
		messageId: Type.String(),
		text: Type.String(),
		reason: Type.Union([
			Type.Literal("aborted"),
			Type.Literal("error"),
			Type.Literal("interrupted"),
			Type.Literal("cancelled"),
			Type.Literal("expired"),
		]),
	},
	{ additionalProperties: false },
);
export type MessageUndeliveredEvent = Static<typeof MessageUndeliveredEvent>;

export const TurnCancelRequestedEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("human"),
		type: Type.Literal("turn_cancel_requested"),
	},
	{ additionalProperties: false },
);
export type TurnCancelRequestedEvent = Static<typeof TurnCancelRequestedEvent>;

export const MessageDeltaEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("agent"),
		modelRole: Type.Literal("assistant"),
		type: Type.Literal("message_delta"),
		messageId: Type.String(),
		offset: Type.Number(),
		text: Type.String(),
	},
	{ additionalProperties: false },
);
export type MessageDeltaEvent = Static<typeof MessageDeltaEvent>;

// Only the model's reasoning summary crosses the wire.
export const ReasoningDeltaEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("agent"),
		modelRole: Type.Literal("assistant"),
		type: Type.Literal("reasoning_delta"),
		messageId: Type.String(),
		offset: Type.Number(),
		text: Type.String(),
	},
	{ additionalProperties: false },
);
export type ReasoningDeltaEvent = Static<typeof ReasoningDeltaEvent>;

export const AssistantMessageCompletedEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("agent"),
		modelRole: Type.Literal("assistant"),
		type: Type.Literal("assistant_message_completed"),
		messageId: Type.String(),
		reason: Type.Union([Type.Literal("completed"), Type.Literal("length")]),
	},
	{ additionalProperties: false },
);
export type AssistantMessageCompletedEvent = Static<typeof AssistantMessageCompletedEvent>;

export const UsageEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("usage"),
		provider: Provider,
		model: Type.String(),
		usage: Usage,
	},
	{ additionalProperties: false },
);
export type UsageEvent = Static<typeof UsageEvent>;

export const ErrorCode = Type.Literal("identity_changed");
export type ErrorCode = Static<typeof ErrorCode>;

export const ErrorEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("error"),
		message: Type.String(),
		code: Type.Optional(ErrorCode),
		expected: Type.Optional(Identity),
		actual: Type.Optional(Identity),
	},
	{ additionalProperties: false },
);
export type ErrorEvent = Static<typeof ErrorEvent>;

export const RetryEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("retry"),
		attempt: Type.Number(),
		maxAttempts: Type.Number(),
		delayMs: Type.Number(),
		message: Type.String(),
	},
	{ additionalProperties: false },
);
export type RetryEvent = Static<typeof RetryEvent>;

export const AuthEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("auth"),
		mode: Type.Union([Type.Literal("apikey"), Type.Literal("oauth")]),
	},
	{ additionalProperties: false },
);
export type AuthEvent = Static<typeof AuthEvent>;

export const EndEvent = Type.Object(
	{ ...turnEventFields, actor: Type.Literal("process"), type: Type.Literal("end") },
	{ additionalProperties: false },
);
export type EndEvent = Static<typeof EndEvent>;

export const AbortedEvent = Type.Object(
	{ ...turnEventFields, actor: Type.Literal("process"), type: Type.Literal("aborted") },
	{ additionalProperties: false },
);
export type AbortedEvent = Static<typeof AbortedEvent>;

export const InterruptedEvent = Type.Object(
	{ ...turnEventFields, actor: Type.Literal("process"), type: Type.Literal("interrupted") },
	{ additionalProperties: false },
);
export type InterruptedEvent = Static<typeof InterruptedEvent>;

export const CancelledEvent = Type.Object(
	{ ...turnEventFields, actor: Type.Literal("process"), type: Type.Literal("cancelled") },
	{ additionalProperties: false },
);
export type CancelledEvent = Static<typeof CancelledEvent>;

export const TurnTerminalEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("turn_terminal"),
		reason: TurnTerminalReason,
	},
	{ additionalProperties: false },
);
export type TurnTerminalEvent = Static<typeof TurnTerminalEvent>;

export const QueueChangedEvent = Type.Object(
	{
		...eventFields,
		actor: Type.Literal("process"),
		type: Type.Literal("queue_changed"),
		queue: QueueSnapshot,
	},
	{ additionalProperties: false },
);
export type QueueChangedEvent = Static<typeof QueueChangedEvent>;

export const ToolCallEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("agent"),
		modelRole: Type.Literal("assistant"),
		type: Type.Literal("tool_call"),
		messageId: Type.String(),
		id: Type.String(),
		name: Type.String(),
		arguments: Type.String(),
	},
	{ additionalProperties: false },
);
export type ToolCallEvent = Static<typeof ToolCallEvent>;

export const ToolResultEvent = Type.Object(
	{
		...turnEventFields,
		actor: Type.Literal("process"),
		modelRole: Type.Literal("tool"),
		type: Type.Literal("tool_result"),
		id: Type.String(),
		name: Type.String(),
		status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
		output: Type.String(),
		details: Type.Optional(ToolDetails),
	},
	{ additionalProperties: false },
);
export type ToolResultEvent = Static<typeof ToolResultEvent>;

export const Event = Type.Union([
	MessageSubmittedEvent,
	CompactionSubmittedEvent,
	CompactedEvent,
	CompactionSkippedEvent,
	PrunedEvent,
	MessageDeliveredEvent,
	MessageUndeliveredEvent,
	TurnCancelRequestedEvent,
	MessageDeltaEvent,
	ReasoningDeltaEvent,
	AssistantMessageCompletedEvent,
	UsageEvent,
	ErrorEvent,
	RetryEvent,
	AuthEvent,
	AbortedEvent,
	InterruptedEvent,
	CancelledEvent,
	TurnTerminalEvent,
	QueueChangedEvent,
	EndEvent,
	ToolCallEvent,
	ToolResultEvent,
]);
export type Event = Static<typeof Event>;

export type TurnEvent = Exclude<Event, QueueChangedEvent | PrunedEvent>;

export const EventEnvelope = Type.Object(
	{
		epoch: Type.String(),
		sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		event: Event,
	},
	{ additionalProperties: false },
);
export type EventEnvelope = Static<typeof EventEnvelope>;

export const PromptRequest = Type.Object({ text: Type.String({ pattern: "\\S" }) }, { additionalProperties: false });
export type PromptRequest = Static<typeof PromptRequest>;

export const PromptAdmission = Type.Object(
	{
		status: AdmissionStatus,
		sessionId: Type.String(),
		turnId: Type.String(),
		messageId: Type.String(),
		queueItemId: Type.String(),
		queue: QueueSnapshot,
	},
	{ additionalProperties: false },
);
export type PromptAdmission = Static<typeof PromptAdmission>;

export const CompactRequest = Type.Object(
	{ instructions: Type.Optional(Type.String({ pattern: "\\S" })) },
	{ additionalProperties: false },
);
export type CompactRequest = Static<typeof CompactRequest>;

export const CompactionAdmission = Type.Object(
	{
		status: AdmissionStatus,
		sessionId: Type.String(),
		turnId: Type.String(),
		queueItemId: Type.String(),
		queue: QueueSnapshot,
	},
	{ additionalProperties: false },
);
export type CompactionAdmission = Static<typeof CompactionAdmission>;

export const TurnCancellationResult = Type.Object(
	{
		status: CancellationStatus,
		sessionId: Type.String(),
		turnId: Type.String(),
	},
	{ additionalProperties: false },
);
export type TurnCancellationResult = Static<typeof TurnCancellationResult>;

export const Health = Type.Object(
	{
		name: Type.Literal("ker"),
		protocol: Type.String(),
		auth: AuthMode,
	},
	{ additionalProperties: false },
);
export type Health = Static<typeof Health>;

export const ErrorBody = Type.Object(
	{
		code: Type.String(),
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type ErrorBody = Static<typeof ErrorBody>;

export const PROTOCOL_VERSION = "26" as const;

// Default loopback port for the server and CLI clients.
export const DEFAULT_PORT = 5537;
