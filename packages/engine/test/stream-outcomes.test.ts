import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { createHarness, type EngineConfig, type Tool } from "../src/index.ts";

test("stops a content-filtered turn without saving its response or executing its tools", async () => {
	const observed = { streamCalls: 0, toolExecutions: 0 };
	const lookup: Tool = {
		name: "lookup",
		description: "Look up a value",
		parameters: { type: "object" },
		async execute() {
			observed.toolExecutions++;
			return "result";
		},
	};
	const harness = createHarness(createConfig([lookup]), {
		stream: async function* () {
			observed.streamCalls++;
			yield { type: "delta", text: "partial response" };
			yield { type: "tool_call", callId: "call_1", name: "lookup", arguments: "{}" };
			yield {
				type: "done",
				reason: "content_filter",
				usage: { input: 10, output: 3, total: 13 },
			};
		},
	});

	assert.deepEqual(await collectEvents(harness.send("hello")), [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "message_delta", text: "partial response" },
		{ role: "tool", type: "tool_call", id: "call_1", name: "lookup", arguments: "{}" },
		{ role: "assistant", type: "usage", input: 10, output: 3, total: 13 },
		{ role: "assistant", type: "error", message: "The model response was stopped by a content filter" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [{ role: "user", content: "hello" }]);
	assert.deepEqual(observed, { streamCalls: 1, toolExecutions: 0 });
});

test("saves a length-limited response without reporting an error", async () => {
	const observed = { streamCalls: 0 };
	const harness = createHarness(createConfig(), {
		stream: async function* () {
			observed.streamCalls++;
			yield { type: "delta", text: "truncated response" };
			yield {
				type: "done",
				reason: "length",
				usage: { input: 8, output: 4, total: 12 },
			};
		},
	});

	assert.deepEqual(await collectEvents(harness.send("hello")), [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "message_delta", text: "truncated response" },
		{ role: "assistant", type: "usage", input: 8, output: 4, total: 12 },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "truncated response", toolCalls: [], reasoning: [] },
	]);
	assert.deepEqual(observed, { streamCalls: 1 });
});

function createConfig(tools: Tool[] = []): EngineConfig {
	return {
		model: "test-model",
		getAuth: async () => ({ kind: "apikey", key: "test" }),
		tools,
		systemPrompt: "Test system prompt",
	};
}

async function collectEvents(events: AsyncIterable<Protocol.Event>): Promise<Protocol.Event[]> {
	const collected: Protocol.Event[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}
