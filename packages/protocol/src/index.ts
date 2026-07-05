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

export type Event = MessageEvent | MessageDeltaEvent | UsageEvent | ErrorEvent | RetryEvent | AuthEvent;

export const PROTOCOL_VERSION = "0" as const;

// Fixed localhost port the daemon listens on. Daemon and clients must agree
// on it, so it lives here rather than in config.
export const DEFAULT_PORT = 5537;
