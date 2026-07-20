// Wire contract between the daemon and its clients.

export type Actor = "human" | "agent" | "process";
export type ModelRole = "user" | "assistant" | "tool";
export type SessionId = string;
export type TurnId = string;
export type MessageId = string;

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
	text: string;
	queued: boolean;
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
	reason: "aborted" | "error";
}

export interface MessageDeltaEvent extends TurnEventBase {
	actor: "agent";
	modelRole: "assistant";
	type: "message_delta";
	text: string;
}

// The model's reasoning summary, streamed in pieces. Only the summary text, not the encrypted reasoning.
export interface ReasoningDeltaEvent extends TurnEventBase {
	actor: "agent";
	modelRole: "assistant";
	type: "reasoning_delta";
	text: string;
}

export interface UsageEvent extends TurnEventBase {
	actor: "process";
	type: "usage";
	input: number;
	output: number;
	total: number;
}

// The credential a conversation is bound to. OAuth logins are told apart by account; API keys
// all count as one identity.
export type Identity = { kind: "apikey" } | { kind: "oauth"; accountId: string };

export type ErrorCode = "identity_changed";

// `code` marks failures a client can act on. An identity_changed error also carries the bound
// (`expected`) and active (`actual`) identities, so each client writes its own remediation.
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

// The conversation-bound credential mode, emitted once per accepted turn. Retries and tool steps
// keep that identity. A daemon /auth/status endpoint would let clients query this state instead.
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

// The daemon discarded the model context and removed its credential binding. Connected clients
// receive this even when another client requested the reset.
export interface ConversationResetEvent extends EventBase {
	actor: "process";
	type: "conversation_reset";
}

// The model asked to run a tool, before it runs. `id` is the provider call id, echoed on the
// matching result so a client can pair the two.
export interface ToolCallEvent extends TurnEventBase {
	actor: "agent";
	modelRole: "assistant";
	type: "tool_call";
	id: string;
	name: string;
	arguments: string;
}

// The tool ran. `output` carries the full result the model saw, so every client renders it as it
// likes; `status` is "error" when the tool threw (the model still receives the error as its result).
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
	| MessageDeltaEvent
	| ReasoningDeltaEvent
	| UsageEvent
	| ErrorEvent
	| RetryEvent
	| AuthEvent
	| AbortedEvent
	| EndEvent
	| ConversationResetEvent
	| ToolCallEvent
	| ToolResultEvent;

export type TurnEvent = Exclude<Event, ConversationResetEvent>;

export const PROTOCOL_VERSION = "4" as const;

// Fixed localhost port the daemon listens on. Daemon and clients must agree
// on it, so it lives here rather than in config.
export const DEFAULT_PORT = 5537;
