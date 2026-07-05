import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";

export interface Message {
	role: "user" | "assistant";
	content: string;
}

export interface Usage {
	input: number;
	output: number;
	total: number;
}

export type Event =
	| { type: "delta"; text: string }
	| { type: "done"; usage: Usage }
	| { type: "error"; message: string; retryable: boolean; retryAfterMs?: number };

// Stream one OpenAI Responses call as `delta` / `done` / `error` events. Never throws: a pre-stream
// reject, a mid-stream SDK error, an in-band `response.failed`, or a stream that ends without a
// terminal event all come back as one `error` event, tagged with whether it's worth retrying and
// any server Retry-After. SDK retries are off (`maxRetries: 0`) so the engine owns the single retry
// policy. A `response.incomplete` (token cap) counts as a normal finish.
export async function* stream(model: string, messages: Message[], apiKey: string): AsyncGenerator<Event> {
	try {
		const client = new OpenAI({ apiKey, maxRetries: 0 });
		const input = messages.map((m) => ({ role: m.role, content: m.content }));
		const events = await client.responses.create({ model, input, stream: true });
		let sawTerminal = false;
		for await (const event of events) {
			if (event.type === "response.output_text.delta") {
				yield { type: "delta", text: event.delta };
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
function classifyError(err: unknown): Classified {
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
function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
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
