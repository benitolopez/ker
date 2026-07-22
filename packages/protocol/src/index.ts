// Wire contract between the daemon and its clients.

export type Actor = "human" | "agent" | "process";
export type ModelRole = "user" | "assistant" | "tool";
export type SessionId = string;
export type TurnId = string;
export type MessageId = string;
export type QueueItemId = string;

export type Placement =
	| { type: "end" }
	| { type: "after_turn"; turnId: TurnId }
	| { type: "running_turn"; turnId: TurnId };

export type AdmissionStatus = "running" | "waiting" | "added_to_running";
export type CancellationStatus = "cancelling" | "cancelled" | "aborted";
export type TurnTerminalReason = "completed" | "aborted" | "error" | "interrupted" | "cancelled";
export type AssistantTerminalReason = "completed" | "length" | "aborted" | "error";

export interface SessionDescriptor {
	id: SessionId;
	cwd: string;
	projectRoot: string;
	createdAt: string;
	updatedAt: string;
}

export interface UnreadableSession {
	id: SessionId;
	error: string;
}

export interface QueueItem {
	id: QueueItemId;
	sessionId: SessionId;
	turnId: TurnId;
	messageId: MessageId;
	text: string;
	state: "running" | "cancelling" | "waiting";
	submittedAt: string;
}

export interface ProjectQueueSnapshot {
	revision: number;
	running?: QueueItem;
	waiting: QueueItem[];
}

export interface Cursor {
	epoch: string;
	sequence: number;
}

export interface AssistantMessage {
	id: MessageId;
	turnId: TurnId;
	text: string;
	reason: AssistantTerminalReason;
}

export interface ActiveAssistantMessage {
	id: MessageId;
	turnId: TurnId;
	text: string;
}

export interface TurnSnapshot {
	id: TurnId;
	status: "running" | "cancelling" | "waiting" | TurnTerminalReason;
}

interface ConversationEntryBase {
	id: string;
	parentId: string | null;
	turnId: TurnId;
	messageId?: MessageId;
}

export type ConversationEntry =
	| (ConversationEntryBase & { role: "user" | "developer"; content: string })
	| (ConversationEntryBase & {
			role: "assistant";
			content: string;
			toolCalls: Array<{ id: string; name: string; arguments: string }>;
	  })
	| (ConversationEntryBase & { role: "tool"; toolCallId: string; content: string });

export interface SessionSnapshot {
	session: SessionDescriptor;
	identity?: Identity;
	entries: ConversationEntry[];
	messages: AssistantMessage[];
	active?: ActiveAssistantMessage;
	turns: TurnSnapshot[];
	queue: ProjectQueueSnapshot;
	cursor: Cursor;
}

export interface EventBase {
	actor: Actor;
	sessionId: SessionId;
	type: string;
}

export interface TurnEventBase extends EventBase {
	turnId: TurnId;
}

export interface MessageSubmittedEvent extends TurnEventBase {
	actor: "human";
	type: "message_submitted";
	messageId: MessageId;
	queueItemId: QueueItemId;
	text: string;
	placement: Placement["type"];
	targetTurnId?: TurnId;
	admission: AdmissionStatus;
}

export interface MessageDeliveredEvent extends TurnEventBase {
	actor: "human";
	modelRole: "user";
	type: "message_delivered";
	messageId: MessageId;
	text: string;
}

export interface MessageUndeliveredEvent extends TurnEventBase {
	actor: "process";
	type: "message_undelivered";
	messageId: MessageId;
	text: string;
	reason: "aborted" | "error" | "interrupted" | "cancelled";
}

export interface TurnCancelRequestedEvent extends TurnEventBase {
	actor: "human";
	type: "turn_cancel_requested";
}

export interface MessageDeltaEvent extends TurnEventBase {
	actor: "agent";
	modelRole: "assistant";
	type: "message_delta";
	messageId: MessageId;
	offset: number;
	text: string;
}

// The model's reasoning summary, streamed in pieces. Only the summary text, not the encrypted reasoning.
export interface ReasoningDeltaEvent extends TurnEventBase {
	actor: "agent";
	modelRole: "assistant";
	type: "reasoning_delta";
	messageId: MessageId;
	offset: number;
	text: string;
}

export interface AssistantMessageCompletedEvent extends TurnEventBase {
	actor: "agent";
	modelRole: "assistant";
	type: "assistant_message_completed";
	messageId: MessageId;
	reason: "completed" | "length";
}

export interface UsageEvent extends TurnEventBase {
	actor: "process";
	type: "usage";
	input: number;
	output: number;
	total: number;
}

// The credential a session is bound to. OAuth logins are told apart by account; API keys all
// count as one identity. Access tokens and API keys never enter this type.
export type Identity = { kind: "apikey" } | { kind: "oauth"; accountId: string };

export type ErrorCode = "identity_changed";

export interface ErrorEvent extends TurnEventBase {
	actor: "process";
	type: "error";
	message: string;
	code?: ErrorCode;
	expected?: Identity;
	actual?: Identity;
}

export interface RetryEvent extends TurnEventBase {
	actor: "process";
	type: "retry";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	message: string;
}

export interface AuthEvent extends TurnEventBase {
	actor: "process";
	type: "auth";
	mode: "apikey" | "oauth";
}

export interface EndEvent extends TurnEventBase {
	actor: "process";
	type: "end";
}

export interface AbortedEvent extends TurnEventBase {
	actor: "process";
	type: "aborted";
}

export interface InterruptedEvent extends TurnEventBase {
	actor: "process";
	type: "interrupted";
}

export interface CancelledEvent extends TurnEventBase {
	actor: "process";
	type: "cancelled";
}

export interface TurnTerminalEvent extends TurnEventBase {
	actor: "process";
	type: "turn_terminal";
	reason: TurnTerminalReason;
}

export interface QueueChangedEvent extends EventBase {
	actor: "process";
	type: "queue_changed";
	queue: ProjectQueueSnapshot;
}

export interface ToolCallEvent extends TurnEventBase {
	actor: "agent";
	modelRole: "assistant";
	type: "tool_call";
	messageId: MessageId;
	id: string;
	name: string;
	arguments: string;
}

export interface ToolResultEvent extends TurnEventBase {
	actor: "process";
	modelRole: "tool";
	type: "tool_result";
	id: string;
	name: string;
	status: "ok" | "error";
	output: string;
}

export type Event =
	| MessageSubmittedEvent
	| MessageDeliveredEvent
	| MessageUndeliveredEvent
	| TurnCancelRequestedEvent
	| MessageDeltaEvent
	| ReasoningDeltaEvent
	| AssistantMessageCompletedEvent
	| UsageEvent
	| ErrorEvent
	| RetryEvent
	| AuthEvent
	| AbortedEvent
	| InterruptedEvent
	| CancelledEvent
	| TurnTerminalEvent
	| QueueChangedEvent
	| EndEvent
	| ToolCallEvent
	| ToolResultEvent;

export type TurnEvent = Exclude<Event, QueueChangedEvent>;

export interface EventEnvelope {
	epoch: string;
	sequence: number;
	event: Event;
}

export interface PromptAdmission {
	status: AdmissionStatus;
	sessionId: SessionId;
	turnId: TurnId;
	messageId: MessageId;
	queueItemId: QueueItemId;
	queue: ProjectQueueSnapshot;
}

export interface TurnCancellationResult {
	status: CancellationStatus;
	sessionId: SessionId;
	turnId: TurnId;
}

export const PROTOCOL_VERSION = "6" as const;

// Fixed localhost port the daemon listens on. Daemon and clients must agree on it.
export const DEFAULT_PORT = 5537;
