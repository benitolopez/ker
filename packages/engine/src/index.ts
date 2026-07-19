import { setTimeout as sleep } from "node:timers/promises";
import * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";

// A tool the loop can run: the wire schema the model sees, plus the execute the model never sees.
export interface Tool extends Llm.Tool {
	execute(args: unknown, signal?: AbortSignal): Promise<string>;
}

export interface EngineConfig {
	model: string;
	getAuth: (signal?: AbortSignal) => Promise<Llm.Auth>;
	tools: Tool[];
	systemPrompt: string;
	reasoningEffort?: Llm.ReasoningEffort;
}

export interface Dependencies {
	stream: typeof Llm.stream;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const ABORTED_HISTORY_MARKER =
	"The previous turn was interrupted by the user. Aborted tools may have partially executed.";

// Holds one credential-bound conversation in memory and runs the agent loop. Each send takes model steps
// until the model answers without asking for a tool: a step streams one reply, and any tools it requested run
// with their results appended to history, so the next turn sees them. Initial auth is resolved and
// checked before the user enters history, then reused for the first provider attempt. Cancellation
// repairs any advertised tool calls before recording the interruption for the next model request.
export function createHarness(config: EngineConfig, dependencies: Dependencies = { stream: Llm.stream }) {
	const messages: Llm.Message[] = [];
	let identity: Protocol.Identity | undefined;

	async function* send(userText: string, signal?: AbortSignal): AsyncGenerator<Protocol.Event> {
		const initialAuth = await resolveAuth(config, identity, signal);
		if (initialAuth.kind === "aborted") {
			yield { role: "assistant", type: "aborted" };
			yield { role: "assistant", type: "end" };
			return;
		}
		if (initialAuth.kind === "error") {
			yield initialAuth.event;
			yield { role: "assistant", type: "end" };
			return;
		}
		identity ??= identityOf(initialAuth.auth);
		messages.push({ role: "user", content: userText });
		let firstStep = true;
		while (true) {
			const outcome = yield* streamStep(
				config,
				dependencies,
				messages,
				identity,
				firstStep ? initialAuth.auth : undefined,
				signal,
			);
			firstStep = false;
			if (outcome.kind === "aborted" || signal?.aborted) {
				if (outcome.kind !== "stopped") {
					for (const event of skipToolCalls(messages, outcome.toolCalls)) yield event;
				}
				messages.push({ role: "developer", content: ABORTED_HISTORY_MARKER });
				yield { role: "assistant", type: "aborted" };
				yield { role: "assistant", type: "end" };
				return;
			}
			if (outcome.kind === "stopped" || outcome.toolCalls.length === 0) break;
			let interrupted = false;
			for (let index = 0; index < outcome.toolCalls.length; index++) {
				const call = outcome.toolCalls[index];
				if (signal?.aborted) {
					for (const event of skipToolCalls(messages, outcome.toolCalls.slice(index))) yield event;
					interrupted = true;
					break;
				}
				const result = await runTool(config.tools, call, signal);
				messages.push({ role: "tool", toolCallId: call.callId, content: result.output });
				yield {
					role: "tool",
					type: "tool_result",
					id: call.callId,
					name: call.name,
					status: result.status,
					output: result.output,
				};
				if (signal?.aborted) {
					for (const event of skipToolCalls(messages, outcome.toolCalls.slice(index + 1))) yield event;
					interrupted = true;
					break;
				}
			}
			if (interrupted) {
				messages.push({ role: "developer", content: ABORTED_HISTORY_MARKER });
				yield { role: "assistant", type: "aborted" };
				yield { role: "assistant", type: "end" };
				return;
			}
		}
		yield { role: "assistant", type: "end" };
	}

	function reset(): void {
		messages.length = 0;
		identity = undefined;
	}

	return { messages, reset, send };
}

type StepOutcome =
	| { kind: "aborted"; toolCalls: Llm.ToolCall[] }
	| { kind: "stopped" }
	| { kind: "done"; toolCalls: Llm.ToolCall[] };

// Stream one model step: re-emit text deltas and tool-call notices as protocol events, record the finished
// assistant message (text, tool calls, reasoning) into history on completion, and return its tool calls for
// the loop to run. Retries fire only before provider output: visible deltas can't be unprinted, and completed
// tool calls or reasoning items can't be safely regenerated. A retryable error waits for the server's
// Retry-After when given, else a capped exponential backoff, announced as a retry event first. Retries and
// later tool steps resolve auth again, so an OAuth token refreshed between requests is used; a resolution
// failure ends the turn.
async function* streamStep(
	config: EngineConfig,
	dependencies: Dependencies,
	messages: Llm.Message[],
	identity: Protocol.Identity,
	initialAuth?: Llm.Auth,
	signal?: AbortSignal,
): AsyncGenerator<Protocol.Event, StepOutcome> {
	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) return { kind: "aborted", toolCalls: [] };
		const authResult: AuthResult =
			attempt === 0 && initialAuth ? { kind: "ready", auth: initialAuth } : await resolveAuth(config, identity, signal);
		if (authResult.kind === "aborted") return { kind: "aborted", toolCalls: [] };
		if (authResult.kind === "error") {
			yield authResult.event;
			return { kind: "stopped" };
		}
		const auth = authResult.auth;
		if (initialAuth && attempt === 0) yield { role: "assistant", type: "auth", mode: auth.kind };
		let reply = "";
		const toolCalls: Llm.ToolCall[] = [];
		const reasoning: unknown[] = [];
		let sawOutput = false;
		let pending: { delayMs: number; message: string } | undefined;

		for await (const event of dependencies.stream(config.model, messages, auth, {
			tools: config.tools,
			instructions: config.systemPrompt,
			reasoningEffort: config.reasoningEffort,
			signal,
		})) {
			if (signal?.aborted || event.type === "aborted") {
				if (toolCalls.length > 0) messages.push({ role: "assistant", content: "", toolCalls, reasoning });
				return { kind: "aborted", toolCalls };
			}
			if (event.type !== "done" && event.type !== "error") sawOutput = true;
			if (event.type === "delta") {
				reply += event.text;
				yield { role: "assistant", type: "message_delta", text: event.text };
			}
			if (event.type === "tool_call") {
				toolCalls.push({ callId: event.callId, itemId: event.itemId, name: event.name, arguments: event.arguments });
				yield { role: "tool", type: "tool_call", id: event.callId, name: event.name, arguments: event.arguments };
			}
			if (event.type === "reasoning_delta") {
				yield { role: "assistant", type: "reasoning_delta", text: event.text };
			}
			if (event.type === "reasoning") reasoning.push(event.item);
			if (event.type === "done") {
				if (event.reason === "content_filter") {
					yield { role: "assistant", type: "usage", ...event.usage };
					yield { role: "assistant", type: "error", message: "The model response was stopped by a content filter" };
					return { kind: "stopped" };
				}
				messages.push({ role: "assistant", content: reply, toolCalls, reasoning });
				yield { role: "assistant", type: "usage", ...event.usage };
				return { kind: "done", toolCalls };
			}
			if (event.type === "error") {
				if (!sawOutput && event.retryable && attempt < MAX_RETRIES) {
					const delayMs = Math.min(event.retryAfterMs ?? BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
					pending = { delayMs, message: event.message };
					break;
				}
				yield { role: "assistant", type: "error", message: event.message };
				return { kind: "stopped" };
			}
		}

		if (!pending) return { kind: "stopped" };
		yield {
			role: "assistant",
			type: "retry",
			attempt: attempt + 1,
			maxAttempts: MAX_RETRIES,
			delayMs: pending.delayMs,
			message: pending.message,
		};
		try {
			await sleep(pending.delayMs, undefined, { signal });
		} catch (error) {
			if (signal?.aborted) return { kind: "aborted", toolCalls: [] };
			throw error;
		}
	}
}

type AuthResult =
	| { kind: "ready"; auth: Llm.Auth }
	| { kind: "aborted" }
	| { kind: "error"; event: Protocol.ErrorEvent };

async function resolveAuth(
	config: EngineConfig,
	expected?: Protocol.Identity,
	signal?: AbortSignal,
): Promise<AuthResult> {
	if (signal?.aborted) return { kind: "aborted" };
	try {
		const auth = await config.getAuth(signal);
		if (signal?.aborted) return { kind: "aborted" };
		const actual = identityOf(auth);
		if (expected && !sameIdentity(expected, actual)) {
			return {
				kind: "error",
				event: {
					role: "assistant",
					type: "error",
					code: "identity_changed",
					expected,
					actual,
					message: `Conversation belongs to ${describeIdentity(expected)}, but ${describeIdentity(actual)} is active.`,
				},
			};
		}
		return { kind: "ready", auth };
	} catch (err) {
		if (signal?.aborted) return { kind: "aborted" };
		return {
			kind: "error",
			event: { role: "assistant", type: "error", message: err instanceof Error ? err.message : String(err) },
		};
	}
}

// The explicit return type makes the switch exhaustive: a new Auth kind fails to compile here
// instead of silently collapsing into the API-key identity.
function identityOf(auth: Llm.Auth): Protocol.Identity {
	switch (auth.kind) {
		case "oauth":
			return { kind: "oauth", accountId: auth.accountId };
		case "apikey":
			return { kind: "apikey" };
	}
}

function sameIdentity(expected: Protocol.Identity, actual: Protocol.Identity): boolean {
	if (expected.kind !== actual.kind) return false;
	if (expected.kind === "oauth" && actual.kind === "oauth") return expected.accountId === actual.accountId;
	return true;
}

function describeIdentity(identity: Protocol.Identity): string {
	if (identity.kind === "oauth") return `OAuth account ${identity.accountId}`;
	return "an API key";
}

// Run one tool call, converting every failure — unknown tool, bad JSON arguments, or a throw from the
// tool — into an error result the model receives as its output, so a bad call never kills the turn.
async function runTool(
	tools: Tool[],
	call: Llm.ToolCall,
	signal?: AbortSignal,
): Promise<{ status: "ok" | "error"; output: string }> {
	const tool = tools.find((t) => t.name === call.name);
	if (!tool) return { status: "error", output: `Tool ${call.name} not found` };
	try {
		const args: unknown = JSON.parse(call.arguments);
		signal?.throwIfAborted();
		return { status: "ok", output: await tool.execute(args, signal) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const output =
			signal?.aborted && !/aborted by user/i.test(message)
				? `${message}\n\n[aborted by user; tool may have partially executed]`
				: message;
		return { status: "error", output };
	}
}

function skipToolCalls(messages: Llm.Message[], calls: Llm.ToolCall[]): Protocol.ToolResultEvent[] {
	return calls.map((call) => {
		const output = "Tool not executed because the turn was aborted.";
		messages.push({ role: "tool", toolCallId: call.callId, content: output });
		return {
			role: "tool",
			type: "tool_result",
			id: call.callId,
			name: call.name,
			status: "error",
			output,
		};
	});
}
