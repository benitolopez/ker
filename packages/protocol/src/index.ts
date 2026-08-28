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
export type WorkspaceId = string;
export type NodeId = string;

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
		cwd: Type.String(),
		projectRoot: Type.String(),
		createdAt: Type.String(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);
export type SessionDescriptor = Static<typeof SessionDescriptor>;

export const CreateSessionRequest = Type.Object({ cwd: Type.String() }, { additionalProperties: false });
export type CreateSessionRequest = Static<typeof CreateSessionRequest>;

export const ReadableCatalogSession = Type.Object(
	{
		status: Type.Union([Type.Literal("idle"), Type.Literal("busy")]),
		id: Type.String(),
		cwd: Type.String(),
		projectId: Type.String(),
		projectName: Type.String(),
		workspaceId: Type.String(),
		nodeId: Type.String(),
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

export const PROTOCOL_VERSION = "19" as const;

// Fixed localhost port the daemon listens on. Daemon and clients must agree on it.
export const DEFAULT_PORT = 5537;
