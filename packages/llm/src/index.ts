import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";

export interface ToolCall {
	callId: string;
	itemId?: string;
	name: string;
	arguments: string;
}

export type Message =
	| { role: "user"; content: string }
	| { role: "developer"; content: string }
	| { role: "assistant"; content: string; toolCalls?: ToolCall[]; reasoning?: unknown[] }
	| { role: "tool"; toolCallId: string; content: string };

// The wire-level view of a tool: the name, prose, and argument schema the model is shown. The engine's
// Tool adds the execute function; the provider never sees or needs it.
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

// OpenAI's reasoning-effort levels. Unset omits `effort` from the request, so the model uses its server
// default, which is none on gpt-5.x.
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface StreamOptions {
	tools?: Tool[];
	instructions?: string;
	reasoningEffort?: ReasoningEffort;
	signal?: AbortSignal;
}

export interface Usage {
	input: number;
	output: number;
	total: number;
}

export type FinishReason = "stop" | "length" | "content_filter";

export type Event =
	| { type: "delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| { type: "tool_call"; callId: string; itemId?: string; name: string; arguments: string }
	| { type: "reasoning"; item: unknown }
	| { type: "done"; reason: FinishReason; usage: Usage }
	| { type: "aborted" }
	| { type: "error"; message: string; retryable: boolean; retryAfterMs?: number };

// How stream() reaches OpenAI: a plain API key against the public API, or a ChatGPT-subscription
// OAuth access token (with the account id decoded from it) against the Codex backend.
export type Auth = { kind: "apikey"; key: string } | { kind: "oauth"; accessToken: string; accountId: string };

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// Stream one OpenAI Responses call as normalized events. It never throws: cancellation returns
// `aborted`, while every failure returns one `error` that says whether a retry is worth it and carries
// any server Retry-After. Failures include a pre-stream reject, a mid-stream SDK error, an in-band
// `error` or `response.failed`, and a stream that ends before a terminal event. SDK retries are off
// (`maxRetries: 0`) so the engine runs the one retry policy. Incomplete responses keep their finish
// reason, so a token cap and a content filter do not look like a normal stop. Reasoning comes back two
// ways: a summary (`summary: "auto"`) streamed as `reasoning_delta`, and the encrypted item (a `reasoning`
// event) kept in history. Both auth paths run
// stateless (`store: false`) and replay the encrypted item next turn, so a reasoning model keeps its
// chain of thought across tool calls. The encrypted item never goes on the wire.
export async function* stream(
	model: string,
	messages: Message[],
	auth: Auth,
	opts?: StreamOptions,
): AsyncGenerator<Event> {
	try {
		const client =
			auth.kind === "oauth"
				? new OpenAI({
						apiKey: auth.accessToken,
						baseURL: CODEX_BASE_URL,
						defaultHeaders: {
							"chatgpt-account-id": auth.accountId,
							originator: "ker",
							"OpenAI-Beta": "responses=experimental",
						},
						maxRetries: 0,
					})
				: new OpenAI({ apiKey: auth.key, maxRetries: 0 });
		const tools: OpenAI.Responses.FunctionTool[] | undefined = opts?.tools?.map((t) => ({
			type: "function",
			name: t.name,
			description: t.description,
			parameters: t.parameters,
			strict: false,
		}));
		const events = await client.responses.create(
			{
				model,
				input: toInput(messages),
				stream: true,
				store: false,
				include: ["reasoning.encrypted_content"],
				reasoning: { effort: opts?.reasoningEffort, summary: "auto" },
				tools,
				instructions: opts?.instructions,
			},
			{ signal: opts?.signal },
		);
		for await (const event of events) {
			if (event.type === "response.output_text.delta") {
				yield { type: "delta", text: event.delta };
			}
			if (event.type === "response.refusal.delta") {
				yield { type: "delta", text: event.delta };
			}
			if (event.type === "response.reasoning_summary_text.delta") {
				yield { type: "reasoning_delta", text: event.delta };
			}
			if (event.type === "response.reasoning_summary_part.done") {
				yield { type: "reasoning_delta", text: "\n\n" };
			}
			if (event.type === "response.output_item.done") {
				const item = event.item;
				if (item.type === "function_call") {
					yield {
						type: "tool_call",
						callId: item.call_id,
						itemId: item.id,
						name: item.name,
						arguments: item.arguments,
					};
				}
				if (item.type === "reasoning") {
					yield { type: "reasoning", item };
				}
			}
			if (event.type === "response.completed") {
				const usage = event.response.usage;
				yield {
					type: "done",
					reason: "stop",
					usage: {
						input: usage?.input_tokens ?? 0,
						output: usage?.output_tokens ?? 0,
						total: usage?.total_tokens ?? 0,
					},
				};
				return;
			}
			if (event.type === "response.incomplete") {
				const reason = event.response.incomplete_details?.reason;
				if (reason !== "max_output_tokens" && reason !== "content_filter") {
					throw new Error("OpenAI response was incomplete without a recognized reason");
				}
				const usage = event.response.usage;
				yield {
					type: "done",
					reason: reason === "max_output_tokens" ? "length" : "content_filter",
					usage: {
						input: usage?.input_tokens ?? 0,
						output: usage?.output_tokens ?? 0,
						total: usage?.total_tokens ?? 0,
					},
				};
				return;
			}
			if (event.type === "response.failed") {
				const error = event.response.error;
				throw new Error(error ? `${error.code}: ${error.message}` : "OpenAI response failed");
			}
			if (event.type === "error") {
				throw new Error(event.code ? `${event.code}: ${event.message}` : event.message);
			}
		}
		throw new Error("OpenAI stream ended before a terminal response event");
	} catch (err) {
		if (opts?.signal?.aborted || err instanceof APIUserAbortError) {
			yield { type: "aborted" };
			return;
		}
		yield { type: "error", ...classifyError(err) };
	}
}

// Rebuild the Responses `input` from the conversation. A reasoning model's assistant turn is replayed in
// the model's own output order — reasoning item(s) first, then any text, then the function calls they
// produced — so the encrypted reasoning stays paired with its call; a tool result is a `function_call_output`
// keyed by the call id.
export function toInput(messages: Message[]): OpenAI.Responses.ResponseInputItem[] {
	const items: OpenAI.Responses.ResponseInputItem[] = [];
	for (const m of messages) {
		if (m.role === "user" || m.role === "developer") {
			items.push({ role: m.role, content: m.content });
			continue;
		}
		if (m.role === "tool") {
			items.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
			continue;
		}
		for (const item of m.reasoning ?? []) items.push(item as OpenAI.Responses.ResponseReasoningItem);
		if (m.content) items.push({ role: "assistant", content: m.content });
		for (const call of m.toolCalls ?? []) {
			items.push({
				type: "function_call",
				call_id: call.callId,
				id: call.itemId,
				name: call.name,
				arguments: call.arguments,
			});
		}
	}
	return items;
}

interface Classified {
	message: string;
	retryable: boolean;
	retryAfterMs?: number;
}

// Reduce any failure to the fields of a terminal error event: a readable message, whether retrying
// is worth it, and any server-requested delay. Retryable mirrors the OpenAI SDK's own rules (transport
// failures and 408/409/429/5xx); auth, bad-request, and quota errors are terminal. In-band provider
// failures and the premature-stream-end guard land in the `Error` branch, where their messages are
// matched against the same server, rate-limit, and overload terms.
export function classifyError(err: unknown): Classified {
	if (err instanceof APIConnectionTimeoutError) return { message: "OpenAI request timed out", retryable: true };
	if (err instanceof APIConnectionError) {
		return { message: "Could not reach OpenAI (connection error)", retryable: true };
	}
	if (err instanceof APIError) {
		const status = err.status;
		const retryable = status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
		return { message: err.message, retryable, retryAfterMs: retryable ? parseRetryAfterMs(err.headers) : undefined };
	}
	if (err instanceof Error) {
		const retryable = /stream ended before a terminal|rate.?limit|server.?error|overloaded|try.?again|timed? out/i.test(
			err.message,
		);
		return { message: err.message, retryable };
	}
	return { message: String(err), retryable: false };
}

// Server-requested backoff from the response headers, in ms: `retry-after-ms` wins, else `retry-after`
// as seconds or an HTTP date. Clamped non-negative; undefined when absent or unparseable.
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
	if (!headers) return undefined;
	const ms = headers.get("retry-after-ms");
	if (ms !== null && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
	const after = headers.get("retry-after");
	if (after === null) return undefined;
	if (Number.isFinite(Number(after))) return Math.max(0, Number(after) * 1000);
	const date = Date.parse(after);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
}
