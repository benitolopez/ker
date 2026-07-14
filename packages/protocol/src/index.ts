// Wire contract between the daemon and its clients.

export type Role = "user" | "assistant" | "tool" | "system";

export interface EventBase {
	role: Role;
	type: string;
}

export interface MessageEvent extends EventBase {
	type: "message";
	text: string;
}

export interface MessageDeltaEvent extends EventBase {
	type: "message_delta";
	text: string;
}

// The model's reasoning summary, streamed in pieces. Only the summary text, not the encrypted reasoning.
export interface ReasoningDeltaEvent extends EventBase {
	type: "reasoning_delta";
	text: string;
}

export interface UsageEvent extends EventBase {
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
export interface ErrorEvent extends EventBase {
	type: "error";
	message: string;
	code?: ErrorCode;
	expected?: Identity;
	actual?: Identity;
}

export interface RetryEvent extends EventBase {
	type: "retry";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	message: string;
}

// The conversation-bound credential mode, emitted once per accepted prompt. Retries and tool turns
// keep that identity. A daemon /auth/status endpoint would let clients query this state instead.
export interface AuthEvent extends EventBase {
	type: "auth";
	mode: "apikey" | "oauth";
}

// The whole response is complete — the model answered without asking for another tool. A `usage` event
// fires per model turn; this fires once at the very end, so a client knows the turn sequence is over.
export interface EndEvent extends EventBase {
	type: "end";
}

// The daemon discarded the model context and removed its credential binding. Connected clients
// receive this even when another client requested the reset.
export interface ConversationResetEvent extends EventBase {
	role: "system";
	type: "conversation_reset";
}

// The model asked to run a tool, before it runs. `id` is the provider call id, echoed on the
// matching result so a client can pair the two.
export interface ToolCallEvent extends EventBase {
	role: "tool";
	type: "tool_call";
	id: string;
	name: string;
	arguments: string;
}

// The tool ran. `output` carries the full result the model saw, so every client renders it as it
// likes; `status` is "error" when the tool threw (the model still receives the error as its result).
export interface ToolResultEvent extends EventBase {
	role: "tool";
	type: "tool_result";
	id: string;
	name: string;
	status: "ok" | "error";
	output: string;
}

export type Event =
	| MessageEvent
	| MessageDeltaEvent
	| ReasoningDeltaEvent
	| UsageEvent
	| ErrorEvent
	| RetryEvent
	| AuthEvent
	| EndEvent
	| ConversationResetEvent
	| ToolCallEvent
	| ToolResultEvent;

export const PROTOCOL_VERSION = "2" as const;

// Fixed localhost port the daemon listens on. Daemon and clients must agree
// on it, so it lives here rather than in config.
export const DEFAULT_PORT = 5537;
