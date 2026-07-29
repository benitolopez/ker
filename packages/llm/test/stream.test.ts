import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import OpenAI, { APIUserAbortError } from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { type Event, normalizeUsage, stream } from "../src/index.ts";

const responsesPrototype = Object.getPrototypeOf(new OpenAI({ apiKey: "test" }).responses) as Pick<
	OpenAI["responses"],
	"create"
>;

test("streams refusal text before completing normally", async (t) => {
	mockStream(t, [
		{
			type: "response.refusal.delta",
			delta: "I can't help with that.",
		} as ResponseStreamEvent,
		completedEvent(),
	]);

	assert.deepEqual(await collectStream(), [
		{ type: "delta", text: "I can't help with that." },
		{ type: "done", reason: "stop", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 } },
	]);
});

test("surfaces a top-level provider error without retrying an invalid prompt", async (t) => {
	mockStream(t, [
		{
			type: "error",
			code: "invalid_prompt",
			message: "The prompt is invalid",
		} as ResponseStreamEvent,
	]);

	assert.deepEqual(await collectStream(), [
		{ type: "error", message: "invalid_prompt: The prompt is invalid", retryable: false },
	]);
});

test("normalizes a top-level context overflow error", async (t) => {
	mockStream(t, [
		{
			type: "error",
			code: "context_length_exceeded",
			message: "The request is too large",
		} as ResponseStreamEvent,
	]);

	assert.deepEqual(await collectStream(), [
		{
			type: "error",
			message: "context_length_exceeded: The request is too large",
			retryable: false,
			contextOverflow: true,
		},
	]);
});

test("maps a max-output incomplete response to a length finish", async (t) => {
	mockStream(t, [incompleteEvent("max_output_tokens")]);

	assert.deepEqual(await collectStream(), [
		{ type: "done", reason: "length", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 } },
	]);
});

test("maps a filtered incomplete response to a content-filter finish", async (t) => {
	mockStream(t, [incompleteEvent("content_filter")]);

	assert.deepEqual(await collectStream(), [
		{ type: "done", reason: "content_filter", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 } },
	]);
});

test("separates cached input, cache writes, and reasoning without double counting", () => {
	const usage = {
		input_tokens: 13,
		input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
		output_tokens: 5,
		output_tokens_details: { reasoning_tokens: 3 },
		total_tokens: 18,
	} as OpenAI.Responses.ResponseUsage & {
		input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
	};

	assert.deepEqual(normalizeUsage(usage), {
		input: 7,
		output: 5,
		cacheRead: 4,
		cacheWrite: 2,
		reasoning: 3,
		total: 18,
	});
});

test("rejects an incomplete response without a recognized reason", async (t) => {
	mockStream(t, [incompleteEvent(undefined)]);

	assert.deepEqual(await collectStream(), [
		{
			type: "error",
			message: "OpenAI response was incomplete without a recognized reason",
			retryable: false,
		},
	]);
});

test("passes the abort signal to OpenAI and reports cancellation separately", async (t) => {
	const controller = new AbortController();
	controller.abort();
	t.mock.method(responsesPrototype, "create", (...args: Parameters<OpenAI["responses"]["create"]>) => {
		const options = args[1];
		assert.equal(options?.signal, controller.signal);
		throw new APIUserAbortError();
	});

	const events: Event[] = [];
	for await (const event of stream(
		"gpt-5",
		[{ role: "user", content: "hello" }],
		{ kind: "apikey", key: "test" },
		{ signal: controller.signal },
	)) {
		events.push(event);
	}

	assert.deepEqual(events, [{ type: "aborted" }]);
});

test("passes the output token cap to OpenAI", async (t) => {
	t.mock.method(responsesPrototype, "create", (...args: Parameters<OpenAI["responses"]["create"]>) => {
		assert.equal(args[0].max_output_tokens, 1234);
		return {
			async *[Symbol.asyncIterator]() {
				yield completedEvent();
			},
		} as never;
	});

	const events: Event[] = [];
	for await (const event of stream(
		"gpt-5",
		[{ role: "user", content: "hello" }],
		{ kind: "apikey", key: "test" },
		{ maxOutputTokens: 1234 },
	)) {
		events.push(event);
	}

	assert.equal(events.at(-1)?.type, "done");
});

function mockStream(t: TestContext, events: ResponseStreamEvent[]) {
	t.mock.method(
		responsesPrototype,
		"create",
		() =>
			({
				async *[Symbol.asyncIterator]() {
					for (const event of events) yield event;
				},
			}) as never,
	);
}

async function collectStream(): Promise<Event[]> {
	const events: Event[] = [];
	for await (const event of stream("gpt-5", [{ role: "user", content: "hello" }], { kind: "apikey", key: "test" })) {
		events.push(event);
	}
	return events;
}

function completedEvent(): ResponseStreamEvent {
	return {
		type: "response.completed",
		response: {
			usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
		},
	} as ResponseStreamEvent;
}

function incompleteEvent(reason: "max_output_tokens" | "content_filter" | undefined): ResponseStreamEvent {
	return {
		type: "response.incomplete",
		response: {
			incomplete_details: reason ? { reason } : null,
			usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
		},
	} as ResponseStreamEvent;
}
