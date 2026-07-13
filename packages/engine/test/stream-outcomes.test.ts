import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { createHarness, type EngineConfig, type Tool } from "../src/index.ts";

test("does not admit a prompt when initial auth resolution fails", async () => {
	const observed = { loggedIn: true, streamCalls: 0 };
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () => {
				if (!observed.loggedIn) throw new Error("not logged in");
				return { kind: "apikey", key: "test" };
			},
		},
		{
			stream: async function* () {
				observed.streamCalls++;
				yield { type: "delta", text: "first response" };
				yield { type: "done", reason: "stop", usage: { input: 2, output: 2, total: 4 } };
			},
		},
	);

	await collectEvents(harness.send("first"));
	observed.loggedIn = false;

	assert.deepEqual(await collectEvents(harness.send("second")), [
		{ role: "assistant", type: "error", message: "not logged in" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [
		{ role: "user", content: "first" },
		{ role: "assistant", content: "first response", toolCalls: [], reasoning: [] },
	]);
	assert.deepEqual(observed, { loggedIn: false, streamCalls: 1 });
});

test("does not restore an auth-rejected prompt after login and resubmission", async () => {
	const observed = { loggedIn: false, providerUsers: [] as string[][] };
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () => {
				if (!observed.loggedIn) throw new Error("not logged in");
				return { kind: "apikey", key: "test" };
			},
		},
		{
			stream: async function* (_model, messages) {
				const users: string[] = [];
				for (const message of messages) {
					if (message.role === "user") users.push(message.content);
				}
				observed.providerUsers.push(users);
				yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
			},
		},
	);

	assert.deepEqual(await collectEvents(harness.send("rejected")), [
		{ role: "assistant", type: "error", message: "not logged in" },
		{ role: "assistant", type: "end" },
	]);
	observed.loggedIn = true;
	await collectEvents(harness.send("resubmitted"));

	assert.deepEqual(observed.providerUsers, [["resubmitted"]]);
	assert.deepEqual(harness.messages, [
		{ role: "user", content: "resubmitted" },
		{ role: "assistant", content: "", toolCalls: [], reasoning: [] },
	]);
});

test("reuses preflight auth for the initial provider attempt", async () => {
	const observed = { authCalls: 0, providerKeys: [] as string[] };
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () => ({ kind: "apikey", key: `key-${++observed.authCalls}` }),
		},
		{
			stream: async function* (_model, _messages, auth) {
				if (auth.kind === "apikey") observed.providerKeys.push(auth.key);
				yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
			},
		},
	);

	await collectEvents(harness.send("hello"));

	assert.deepEqual(observed, { authCalls: 1, providerKeys: ["key-1"] });
});

test("resolves fresh auth before retrying the provider", async () => {
	const observed = { authCalls: 0, streamCalls: 0, providerKeys: [] as string[] };
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () => ({ kind: "apikey", key: `key-${++observed.authCalls}` }),
		},
		{
			stream: async function* (_model, _messages, auth) {
				observed.streamCalls++;
				if (auth.kind === "apikey") observed.providerKeys.push(auth.key);
				if (observed.streamCalls === 1) {
					yield { type: "error", message: "retry me", retryable: true, retryAfterMs: 0 };
					return;
				}
				yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
			},
		},
	);

	assert.deepEqual(await collectEvents(harness.send("hello")), [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "retry", attempt: 1, maxAttempts: 3, delayMs: 0, message: "retry me" },
		{ role: "assistant", type: "usage", input: 1, output: 1, total: 2 },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(observed, { authCalls: 2, streamCalls: 2, providerKeys: ["key-1", "key-2"] });
});

test("keeps an admitted prompt when the provider rejects it", async () => {
	const harness = createHarness(createConfig(), {
		stream: async function* () {
			yield { type: "error", message: "invalid token", retryable: false };
		},
	});

	assert.deepEqual(await collectEvents(harness.send("hello")), [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "error", message: "invalid token" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [{ role: "user", content: "hello" }]);
});

test("keeps completed tool history when auth disappears before the next model turn", async () => {
	const observed = { authCalls: 0 };
	const lookup: Tool = {
		name: "lookup",
		description: "Look up a value",
		parameters: { type: "object" },
		async execute() {
			return "result";
		},
	};
	const harness = createHarness(
		{
			...createConfig([lookup]),
			getAuth: async () => {
				if (++observed.authCalls > 1) throw new Error("logged out");
				return { kind: "apikey", key: "test" };
			},
		},
		{
			stream: async function* () {
				yield { type: "tool_call", callId: "call_1", name: "lookup", arguments: "{}" };
				yield { type: "done", reason: "stop", usage: { input: 2, output: 1, total: 3 } };
			},
		},
	);

	assert.deepEqual(await collectEvents(harness.send("hello")), [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "tool", type: "tool_call", id: "call_1", name: "lookup", arguments: "{}" },
		{ role: "assistant", type: "usage", input: 2, output: 1, total: 3 },
		{ role: "tool", type: "tool_result", id: "call_1", name: "lookup", status: "ok", output: "result" },
		{ role: "assistant", type: "error", message: "logged out" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: "",
			toolCalls: [{ callId: "call_1", itemId: undefined, name: "lookup", arguments: "{}" }],
			reasoning: [],
		},
		{ role: "tool", toolCallId: "call_1", content: "result" },
	]);
	assert.deepEqual(observed, { authCalls: 2 });
});

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
