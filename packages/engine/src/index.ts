import * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";

export interface EngineConfig {
	apiKey: string;
	model: string;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

// Holds the conversation in memory. On each send it streams the assistant reply as events, then
// records the finished message so later turns have context.
export function createHarness(config: EngineConfig) {
	const messages: Llm.Message[] = [];

	// Retries fire only before the first token — every transient failure is a connect-phase error, and
	// once text has streamed to a raw stdout it can't be unprinted. A retryable error waits for the
	// server's Retry-After when given, else an exponential backoff (capped), announced as a retry event
	// before sleeping.
	async function* send(userText: string): AsyncGenerator<Protocol.Event> {
		messages.push({ role: "user", content: userText });

		for (let attempt = 0; ; attempt++) {
			let reply = "";
			let sawToken = false;
			let pending: { delayMs: number; message: string } | undefined;

			for await (const event of Llm.stream(config.model, messages, config.apiKey)) {
				if (event.type === "delta") {
					sawToken = true;
					reply += event.text;
					yield { role: "assistant", type: "message_delta", text: event.text };
				}
				if (event.type === "done") {
					messages.push({ role: "assistant", content: reply });
					yield { role: "assistant", type: "usage", ...event.usage };
					return;
				}
				if (event.type === "error") {
					if (!sawToken && event.retryable && attempt < MAX_RETRIES) {
						const delayMs = Math.min(event.retryAfterMs ?? BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
						pending = { delayMs, message: event.message };
						break;
					}
					yield { role: "assistant", type: "error", message: event.message };
					return;
				}
			}

			if (!pending) return;
			const { delayMs, message } = pending;
			yield { role: "assistant", type: "retry", attempt: attempt + 1, maxAttempts: MAX_RETRIES, delayMs, message };
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	return { messages, send };
}
