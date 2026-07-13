import * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";

// A tool the loop can run: the wire schema the model sees, plus the execute the model never sees.
export interface Tool extends Llm.Tool {
	execute(args: unknown): Promise<string>;
}

export interface EngineConfig {
	model: string;
	getAuth: () => Promise<Llm.Auth>;
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

// Holds the conversation in memory and runs the agent loop. Each send takes turns until the model answers
// without asking for a tool: a turn streams one reply, and if it requested tools we run them, append the
// results to history, and loop so the next turn sees them. No turn cap — a runaway loop is only stopped by
// aborting the turn, but the daemon has no graceful turn cancellation. Initial auth is resolved before the
// user enters history and reused for the first provider attempt.
export function createHarness(config: EngineConfig, dependencies: Dependencies = { stream: Llm.stream }) {
	const messages: Llm.Message[] = [];

	async function* send(userText: string): AsyncGenerator<Protocol.Event> {
		const initialAuth = await resolveAuth(config);
		if (initialAuth.kind === "error") {
			yield { role: "assistant", type: "error", message: initialAuth.message };
			yield { role: "assistant", type: "end" };
			return;
		}
		messages.push({ role: "user", content: userText });
		let firstTurn = true;
		while (true) {
			const outcome = yield* streamTurn(config, dependencies, messages, firstTurn ? initialAuth.auth : undefined);
			firstTurn = false;
			if (outcome.kind === "stopped" || outcome.toolCalls.length === 0) break;
			for (const call of outcome.toolCalls) {
				const result = await runTool(config.tools, call);
				messages.push({ role: "tool", toolCallId: call.callId, content: result.output });
				yield {
					role: "tool",
					type: "tool_result",
					id: call.callId,
					name: call.name,
					status: result.status,
					output: result.output,
				};
			}
		}
		yield { role: "assistant", type: "end" };
	}

	return { messages, send };
}

type TurnOutcome = { kind: "stopped" } | { kind: "done"; toolCalls: Llm.ToolCall[] };

// Stream one model turn: re-emit text deltas and tool-call notices as protocol events, record the finished
// assistant message (text, tool calls, reasoning) into history on completion, and return its tool calls for
// the loop to run. Retries fire only before the first token — every transient failure is a connect-phase
// error, and streamed text can't be unprinted. A retryable error waits for the server's Retry-After when
// given, else a capped exponential backoff, announced as a retry event first. Retries and later tool turns
// resolve auth again, so an OAuth token refreshed between requests is used; a resolution failure ends the turn.
async function* streamTurn(
	config: EngineConfig,
	dependencies: Dependencies,
	messages: Llm.Message[],
	initialAuth?: Llm.Auth,
): AsyncGenerator<Protocol.Event, TurnOutcome> {
	for (let attempt = 0; ; attempt++) {
		const authResult: AuthResult =
			attempt === 0 && initialAuth ? { kind: "ready", auth: initialAuth } : await resolveAuth(config);
		if (authResult.kind === "error") {
			yield { role: "assistant", type: "error", message: authResult.message };
			return { kind: "stopped" };
		}
		const auth = authResult.auth;
		if (initialAuth && attempt === 0) yield { role: "assistant", type: "auth", mode: auth.kind };
		let reply = "";
		const toolCalls: Llm.ToolCall[] = [];
		const reasoning: unknown[] = [];
		let sawToken = false;
		let pending: { delayMs: number; message: string } | undefined;

		for await (const event of dependencies.stream(config.model, messages, auth, {
			tools: config.tools,
			instructions: config.systemPrompt,
			reasoningEffort: config.reasoningEffort,
		})) {
			if (event.type === "delta") {
				sawToken = true;
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
				if (!sawToken && event.retryable && attempt < MAX_RETRIES) {
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
		await new Promise((resolve) => setTimeout(resolve, pending.delayMs));
	}
}

type AuthResult = { kind: "ready"; auth: Llm.Auth } | { kind: "error"; message: string };

async function resolveAuth(config: EngineConfig): Promise<AuthResult> {
	try {
		return { kind: "ready", auth: await config.getAuth() };
	} catch (err) {
		return { kind: "error", message: err instanceof Error ? err.message : String(err) };
	}
}

// Run one tool call, converting every failure — unknown tool, bad JSON arguments, or a throw from the
// tool — into an error result the model receives as its output, so a bad call never kills the turn.
async function runTool(tools: Tool[], call: Llm.ToolCall): Promise<{ status: "ok" | "error"; output: string }> {
	const tool = tools.find((t) => t.name === call.name);
	if (!tool) return { status: "error", output: `Tool ${call.name} not found` };
	try {
		const args: unknown = JSON.parse(call.arguments);
		return { status: "ok", output: await tool.execute(args) };
	} catch (err) {
		return { status: "error", output: err instanceof Error ? err.message : String(err) };
	}
}
