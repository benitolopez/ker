import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";

export interface ToolCall {
	callId: string;
	itemId?: string;
	name: string;
	arguments: string;
}

export type Message =
	| { role: "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: ToolCall[]; reasoning?: unknown[] }
	| { role: "tool"; toolCallId: string; content: string };

// The wire-level view of a tool: the name, prose, and argument schema the model is shown. The engine's
// Tool adds the execute function; the provider never sees or needs it.
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface StreamOptions {
	tools?: Tool[];
	instructions?: string;
}

export interface Usage {
	input: number;
	output: number;
	total: number;
}

export type Event =
	| { type: "delta"; text: string }
	| { type: "tool_call"; callId: string; itemId?: string; name: string; arguments: string }
	| { type: "reasoning"; item: unknown }
	| { type: "done"; usage: Usage }
	| { type: "error"; message: string; retryable: boolean; retryAfterMs?: number };

// How stream() reaches OpenAI: a plain API key against the public API, or a ChatGPT-subscription
// OAuth access token (with the account id decoded from it) against the Codex backend.
export type Auth = { kind: "apikey"; key: string } | { kind: "oauth"; accessToken: string; accountId: string };

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// Stream one OpenAI Responses call as `delta` / `tool_call` / `reasoning` / `done` / `error` events. Never
// throws: a pre-stream reject, a mid-stream SDK error, an in-band `response.failed`, or a stream that ends
// without a terminal event all come back as one `error` event, tagged with whether it's worth retrying and
// any server Retry-After. SDK retries are off (`maxRetries: 0`) so the engine owns the single retry policy.
// A `response.incomplete` (token cap) counts as a normal finish. Both auth paths run stateless (`store:
// false`) and ask for the encrypted reasoning back, so the reasoning items surfaced here can be replayed in
// `input` next turn — required for a reasoning model to keep its chain of thought across tool calls.
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
		const events = await client.responses.create({
			model,
			input: toInput(messages),
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
			tools,
			instructions: opts?.instructions,
		});
		let sawTerminal = false;
		for await (const event of events) {
			if (event.type === "response.output_text.delta") {
				yield { type: "delta", text: event.delta };
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
			if (event.type === "response.completed" || event.type === "response.incomplete") {
				sawTerminal = true;
				const usage = event.response.usage;
				yield {
					type: "done",
					usage: {
						input: usage?.input_tokens ?? 0,
						output: usage?.output_tokens ?? 0,
						total: usage?.total_tokens ?? 0,
					},
				};
			}
			if (event.type === "response.failed") {
				const error = event.response.error;
				throw new Error(error ? `${error.code}: ${error.message}` : "OpenAI response failed");
			}
		}
		if (!sawTerminal) throw new Error("OpenAI stream ended before a terminal response event");
	} catch (err) {
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
		if (m.role === "user") {
			items.push({ role: "user", content: m.content });
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
// failures and 408/409/429/5xx); auth, bad-request, and quota errors are terminal. The two in-band
// throws land in the `Error` branch: the premature-stream-end guard is transient, and `response.failed`
// exposes only a provider code string, matched against the same server/rate/overload codes.
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
