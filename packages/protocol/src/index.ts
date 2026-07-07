// Wire contract between the daemon and its clients.

export type Role = "user" | "assistant" | "tool";

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

export interface UsageEvent extends EventBase {
	type: "usage";
	input: number;
	output: number;
	total: number;
}

export interface ErrorEvent extends EventBase {
	type: "error";
	message: string;
}

export interface RetryEvent extends EventBase {
	type: "retry";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	message: string;
}

// Which credential the turn ran on: a plain API key, or a ChatGPT-subscription OAuth login.
export interface AuthEvent extends EventBase {
	type: "auth";
	mode: "apikey" | "oauth";
}

// The whole response is complete — the model answered without asking for another tool. A `usage` event
// fires per model turn; this fires once at the very end, so a client knows the turn sequence is over.
export interface EndEvent extends EventBase {
	type: "end";
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
	| UsageEvent
	| ErrorEvent
	| RetryEvent
	| AuthEvent
	| EndEvent
	| ToolCallEvent
	| ToolResultEvent;

export const PROTOCOL_VERSION = "0" as const;

// Fixed localhost port the daemon listens on. Daemon and clients must agree
// on it, so it lives here rather than in config.
export const DEFAULT_PORT = 5537;
