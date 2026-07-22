import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";
import { createHarness, type EngineConfig, type Tool, type TurnInput } from "../src/index.ts";

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

	await collectEvents(send(harness, "first"));
	observed.loggedIn = false;

	assert.deepEqual(await collectEvents(send(harness, "second")), [
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

	assert.deepEqual(await collectEvents(send(harness, "rejected")), [
		{ role: "assistant", type: "error", message: "not logged in" },
		{ role: "assistant", type: "end" },
	]);
	observed.loggedIn = true;
	await collectEvents(send(harness, "resubmitted"));

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

	await collectEvents(send(harness, "hello"));

	assert.deepEqual(observed, { authCalls: 1, providerKeys: ["key-1"] });
});

test("rejects a changed oauth account before admitting the prompt", async () => {
	const observed = { accountId: "acc_old", streamCalls: 0 };
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () => ({ kind: "oauth", accessToken: "token", accountId: observed.accountId }),
		},
		{
			stream: async function* () {
				observed.streamCalls++;
				yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
			},
		},
	);

	await collectEvents(send(harness, "first"));
	observed.accountId = "acc_new";

	assert.deepEqual(await collectEvents(send(harness, "rejected")), [
		{
			role: "assistant",
			type: "error",
			code: "identity_changed",
			expected: { kind: "oauth", accountId: "acc_old" },
			actual: { kind: "oauth", accountId: "acc_new" },
			message: "Session belongs to OAuth account acc_old, but OAuth account acc_new is active.",
		},
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [
		{ role: "user", content: "first" },
		{ role: "assistant", content: "", toolCalls: [], reasoning: [] },
	]);
	assert.equal(observed.streamCalls, 1);
});

test("rejects a change between oauth and api-key auth", async () => {
	const observed: { auth: Awaited<ReturnType<EngineConfig["getAuth"]>>; streamCalls: number } = {
		auth: { kind: "oauth", accessToken: "token", accountId: "acc_old" },
		streamCalls: 0,
	};
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () => observed.auth,
		},
		{
			stream: async function* () {
				observed.streamCalls++;
				yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
			},
		},
	);

	await collectEvents(send(harness, "first"));
	observed.auth = { kind: "apikey", key: "test" };

	assert.deepEqual(await collectEvents(send(harness, "rejected")), [
		{
			role: "assistant",
			type: "error",
			code: "identity_changed",
			expected: { kind: "oauth", accountId: "acc_old" },
			actual: { kind: "apikey" },
			message: "Session belongs to OAuth account acc_old, but an API key is active.",
		},
		{ role: "assistant", type: "end" },
	]);
	assert.equal(observed.streamCalls, 1);
});

test("allows the original oauth account after rejecting another account", async () => {
	const observed = { accountId: "acc_old", providerUsers: [] as string[][] };
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () => ({ kind: "oauth", accessToken: "token", accountId: observed.accountId }),
		},
		{
			stream: async function* (_model, messages) {
				observed.providerUsers.push(
					messages.filter((message) => message.role === "user").map((message) => message.content),
				);
				yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
			},
		},
	);

	await collectEvents(send(harness, "first"));
	observed.accountId = "acc_new";
	await collectEvents(send(harness, "rejected"));
	observed.accountId = "acc_old";
	await collectEvents(send(harness, "second"));

	assert.deepEqual(observed.providerUsers, [["first"], ["first", "second"]]);
});

test("stops before a tool follow-up when the oauth account changes mid-turn", async () => {
	const observed = { accountId: "acc_old", streamCalls: 0 };
	const switchAccount: Tool = {
		name: "switch_account",
		description: "Switch the active account",
		parameters: { type: "object" },
		async execute() {
			observed.accountId = "acc_new";
			return "switched";
		},
	};
	const harness = createHarness(
		{
			...createConfig([switchAccount]),
			getAuth: async () => ({ kind: "oauth", accessToken: "token", accountId: observed.accountId }),
		},
		{
			stream: async function* () {
				observed.streamCalls++;
				yield { type: "tool_call", callId: "call_1", name: "switch_account", arguments: "{}" };
				yield { type: "done", reason: "stop", usage: { input: 2, output: 1, total: 3 } };
			},
		},
	);

	const events = await collectEvents(send(harness, "hello"));

	assert.deepEqual(events.at(-2), {
		role: "assistant",
		type: "error",
		code: "identity_changed",
		expected: { kind: "oauth", accountId: "acc_old" },
		actual: { kind: "oauth", accountId: "acc_new" },
		message: "Session belongs to OAuth account acc_old, but OAuth account acc_new is active.",
	});
	assert.deepEqual(events.at(-1), { role: "assistant", type: "end" });
	assert.equal(observed.streamCalls, 1);
	assert.deepEqual(harness.messages, [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: "",
			toolCalls: [{ callId: "call_1", itemId: undefined, name: "switch_account", arguments: "{}" }],
			reasoning: [],
		},
		{ role: "tool", toolCallId: "call_1", content: "switched" },
	]);
});

test("stops before a tool follow-up when auth changes from oauth to an api key", async () => {
	const observed = { useApiKey: false, streamCalls: 0 };
	const switchAuth: Tool = {
		name: "switch_auth",
		description: "Switch the active authentication",
		parameters: { type: "object" },
		async execute() {
			observed.useApiKey = true;
			return "switched";
		},
	};
	const harness = createHarness(
		{
			...createConfig([switchAuth]),
			getAuth: async () =>
				observed.useApiKey
					? { kind: "apikey", key: "test" }
					: { kind: "oauth", accessToken: "token", accountId: "acc_old" },
		},
		{
			stream: async function* () {
				observed.streamCalls++;
				yield { type: "tool_call", callId: "call_1", name: "switch_auth", arguments: "{}" };
				yield { type: "done", reason: "stop", usage: { input: 2, output: 1, total: 3 } };
			},
		},
	);

	const events = await collectEvents(send(harness, "hello"));

	assert.deepEqual(
		events.filter((event) => event.type === "auth"),
		[{ role: "assistant", type: "auth", mode: "oauth" }],
	);
	assert.deepEqual(events.at(-2), {
		role: "assistant",
		type: "error",
		code: "identity_changed",
		expected: { kind: "oauth", accountId: "acc_old" },
		actual: { kind: "apikey" },
		message: "Session belongs to OAuth account acc_old, but an API key is active.",
	});
	assert.deepEqual(events.at(-1), { role: "assistant", type: "end" });
	assert.equal(observed.streamCalls, 1);
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

	assert.deepEqual(await collectEvents(send(harness, "hello")), [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "retry", attempt: 1, maxAttempts: 3, delayMs: 0, message: "retry me" },
		{ role: "assistant", type: "usage", input: 1, output: 1, total: 2 },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(observed, { authCalls: 2, streamCalls: 2, providerKeys: ["key-1", "key-2"] });
});

test("does not retry after provider output", async (t) => {
	const scenarios: { name: string; output: Llm.Event; visible: Array<Record<string, unknown>> }[] = [
		{
			name: "answer delta",
			output: { type: "delta", text: "partial answer" },
			visible: [{ role: "assistant", type: "message_delta", text: "partial answer" }],
		},
		{
			name: "reasoning delta",
			output: { type: "reasoning_delta", text: "partial reasoning" },
			visible: [{ role: "assistant", type: "reasoning_delta", text: "partial reasoning" }],
		},
		{
			name: "completed tool call",
			output: { type: "tool_call", callId: "call_1", name: "lookup", arguments: "{}" },
			visible: [{ role: "tool", type: "tool_call", id: "call_1", name: "lookup", arguments: "{}" }],
		},
		{
			name: "completed reasoning item",
			output: { type: "reasoning", item: { type: "reasoning", encrypted_content: "encrypted" } },
			visible: [],
		},
	];

	for (const scenario of scenarios) {
		await t.test(scenario.name, async () => {
			const observed = { streamCalls: 0 };
			const harness = createHarness(createConfig(), {
				stream: async function* () {
					observed.streamCalls++;
					yield scenario.output;
					yield { type: "error", message: "stream failed", retryable: true, retryAfterMs: 0 };
				},
			});

			assert.deepEqual(await collectEvents(send(harness, "hello")), [
				{ role: "assistant", type: "auth", mode: "apikey" },
				...scenario.visible,
				{ role: "assistant", type: "error", message: "stream failed" },
				{ role: "assistant", type: "end" },
			]);
			assert.equal(observed.streamCalls, 1);
			assert.deepEqual(harness.messages, [{ role: "user", content: "hello" }]);
		});
	}
});

test("stops a retry when auth changes from oauth to an api key", async () => {
	const observed = { authCalls: 0, streamCalls: 0 };
	const harness = createHarness(
		{
			...createConfig(),
			getAuth: async () =>
				++observed.authCalls === 1
					? { kind: "oauth", accessToken: "token", accountId: "acc_old" }
					: { kind: "apikey", key: "test" },
		},
		{
			stream: async function* () {
				observed.streamCalls++;
				yield { type: "error", message: "retry me", retryable: true, retryAfterMs: 0 };
			},
		},
	);

	assert.deepEqual(await collectEvents(send(harness, "hello")), [
		{ role: "assistant", type: "auth", mode: "oauth" },
		{ role: "assistant", type: "retry", attempt: 1, maxAttempts: 3, delayMs: 0, message: "retry me" },
		{
			role: "assistant",
			type: "error",
			code: "identity_changed",
			expected: { kind: "oauth", accountId: "acc_old" },
			actual: { kind: "apikey" },
			message: "Session belongs to OAuth account acc_old, but an API key is active.",
		},
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(observed, { authCalls: 2, streamCalls: 1 });
});

test("keeps an admitted prompt when the provider rejects it", async () => {
	const harness = createHarness(createConfig(), {
		stream: async function* () {
			yield { type: "error", message: "invalid token", retryable: false };
		},
	});

	assert.deepEqual(await collectEvents(send(harness, "hello")), [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "error", message: "invalid token" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [{ role: "user", content: "hello" }]);
});

test("keeps completed tool history when auth disappears before the next model step", async () => {
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

	assert.deepEqual(await collectEvents(send(harness, "hello")), [
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

	assert.deepEqual(await collectEvents(send(harness, "hello")), [
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

	assert.deepEqual(await collectEvents(send(harness, "hello")), [
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

test("assigns one stable assistant message id and contiguous offsets to a provider response", async () => {
	const harness = createHarness(createConfig(), {
		stream: async function* () {
			yield { type: "delta", text: "hel" };
			yield { type: "delta", text: "lo" };
			yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
		},
	});
	const events = await collectProtocolEvents(send(harness, "hello"), true);
	const deltas = events.filter((event) => event.type === "message_delta");
	const completed = events.find((event) => event.type === "assistant_message_completed");

	assert.equal(deltas.length, 2);
	assert.equal(deltas[0].offset, 0);
	assert.equal(deltas[1].offset, 3);
	assert.equal(deltas[0].messageId, deltas[1].messageId);
	assert.equal(completed?.messageId, deltas[0].messageId);
});

test("aborts before admission without saving the prompt or interruption marker", async () => {
	const authStarted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const harness = createHarness({
		...createConfig(),
		getAuth: (signal) =>
			new Promise((_, reject) => {
				authStarted.resolve();
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	});

	const collecting = collectEvents(send(harness, "hello", controller.signal));
	await authStarted.promise;
	controller.abort();

	assert.deepEqual(await collecting, [
		{ role: "assistant", type: "aborted" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, []);
});

test("drops an incomplete assistant response and records an interruption marker", async () => {
	const streamStarted = Promise.withResolvers<void>();
	const deltaDelivered = Promise.withResolvers<void>();
	const controller = new AbortController();
	const harness = createHarness(createConfig(), {
		stream: async function* (_model, _messages, _auth, options) {
			streamStarted.resolve();
			yield { type: "delta", text: "partial" };
			deltaDelivered.resolve();
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) {
					resolve();
					return;
				}
				options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			yield { type: "aborted" };
		},
	});

	const collecting = collectEvents(send(harness, "hello", controller.signal));
	await streamStarted.promise;
	await deltaDelivered.promise;
	controller.abort();

	assert.deepEqual(await collecting, [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "message_delta", text: "partial" },
		{ role: "assistant", type: "aborted" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages, [
		{ role: "user", content: "hello" },
		{
			role: "developer",
			content: "The previous turn was interrupted by the user. Aborted tools may have partially executed.",
		},
	]);
});

test("repairs a completed tool call from an interrupted provider response", async () => {
	const controller = new AbortController();
	const harness = createHarness(createConfig(), {
		stream: async function* () {
			yield { type: "delta", text: "partial" };
			yield { type: "tool_call", callId: "call_1", name: "lookup", arguments: "{}" };
			yield { type: "aborted" };
		},
	});
	const events: Array<Record<string, unknown>> = [];

	for await (const event of send(harness, "hello", controller.signal)) {
		if (event.type !== "message_delivered") events.push(legacyEvent(event));
		if (event.type === "tool_call") controller.abort();
	}

	assert.deepEqual(events.slice(-3), [
		{
			role: "tool",
			type: "tool_result",
			id: "call_1",
			name: "lookup",
			status: "error",
			output: "Tool not executed because the turn was aborted.",
		},
		{ role: "assistant", type: "aborted" },
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
		{ role: "tool", toolCallId: "call_1", content: "Tool not executed because the turn was aborted." },
		{
			role: "developer",
			content: "The previous turn was interrupted by the user. Aborted tools may have partially executed.",
		},
	]);
});

test("cancels retry backoff without another provider attempt", async () => {
	const controller = new AbortController();
	const observed = { streamCalls: 0 };
	const harness = createHarness(createConfig(), {
		stream: async function* () {
			observed.streamCalls++;
			yield { type: "error", message: "retry later", retryable: true, retryAfterMs: 60_000 };
		},
	});
	const events: Array<Record<string, unknown>> = [];

	for await (const event of send(harness, "hello", controller.signal)) {
		if (event.type !== "message_delivered") events.push(legacyEvent(event));
		if (event.type === "retry") controller.abort();
	}

	assert.deepEqual(events, [
		{ role: "assistant", type: "auth", mode: "apikey" },
		{ role: "assistant", type: "retry", attempt: 1, maxAttempts: 3, delayMs: 30_000, message: "retry later" },
		{ role: "assistant", type: "aborted" },
		{ role: "assistant", type: "end" },
	]);
	assert.equal(observed.streamCalls, 1);
});

test("repairs active and queued tool results before reporting the abort", async () => {
	const toolStarted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const first: Tool = {
		name: "first",
		description: "First tool",
		parameters: { type: "object" },
		execute: (_args, signal) =>
			new Promise((_, reject) => {
				toolStarted.resolve();
				signal?.addEventListener("abort", () => reject(new Error("partial output")), { once: true });
			}),
	};
	const second: Tool = {
		name: "second",
		description: "Second tool",
		parameters: { type: "object" },
		async execute() {
			return "should not run";
		},
	};
	const harness = createHarness(createConfig([first, second]), {
		stream: async function* () {
			yield { type: "tool_call", callId: "call_1", name: "first", arguments: "{}" };
			yield { type: "tool_call", callId: "call_2", name: "second", arguments: "{}" };
			yield { type: "done", reason: "stop", usage: { input: 3, output: 2, total: 5 } };
		},
	});

	const collecting = collectEvents(send(harness, "hello", controller.signal));
	await toolStarted.promise;
	controller.abort();
	const events = await collecting;

	assert.deepEqual(events.slice(-4), [
		{
			role: "tool",
			type: "tool_result",
			id: "call_1",
			name: "first",
			status: "error",
			output: "partial output\n\n[aborted by user; tool may have partially executed]",
		},
		{
			role: "tool",
			type: "tool_result",
			id: "call_2",
			name: "second",
			status: "error",
			output: "Tool not executed because the turn was aborted.",
		},
		{ role: "assistant", type: "aborted" },
		{ role: "assistant", type: "end" },
	]);
	assert.deepEqual(harness.messages.slice(-3), [
		{
			role: "tool",
			toolCallId: "call_1",
			content: "partial output\n\n[aborted by user; tool may have partially executed]",
		},
		{ role: "tool", toolCallId: "call_2", content: "Tool not executed because the turn was aborted." },
		{
			role: "developer",
			content: "The previous turn was interrupted by the user. Aborted tools may have partially executed.",
		},
	]);
});

test("repairs every advertised tool when cancellation follows provider completion", async () => {
	const controller = new AbortController();
	const observed = { executions: 0 };
	const lookup: Tool = {
		name: "lookup",
		description: "Look up a value",
		parameters: { type: "object" },
		async execute() {
			observed.executions++;
			return "should not run";
		},
	};
	const harness = createHarness(createConfig([lookup]), {
		stream: async function* () {
			yield { type: "tool_call", callId: "call_1", name: "lookup", arguments: "{}" };
			yield { type: "done", reason: "stop", usage: { input: 2, output: 1, total: 3 } };
		},
	});
	const events: Array<Record<string, unknown>> = [];

	for await (const event of send(harness, "hello", controller.signal)) {
		if (event.type !== "message_delivered") events.push(legacyEvent(event));
		if (event.type === "usage") controller.abort();
	}

	assert.deepEqual(events.slice(-3), [
		{
			role: "tool",
			type: "tool_result",
			id: "call_1",
			name: "lookup",
			status: "error",
			output: "Tool not executed because the turn was aborted.",
		},
		{ role: "assistant", type: "aborted" },
		{ role: "assistant", type: "end" },
	]);
	assert.equal(observed.executions, 0);
	assert.deepEqual(harness.messages.slice(-2), [
		{ role: "tool", toolCallId: "call_1", content: "Tool not executed because the turn was aborted." },
		{
			role: "developer",
			content: "The previous turn was interrupted by the user. Aborted tools may have partially executed.",
		},
	]);
});

test("delivers one steering message after the full tool batch with actor-aware events", async () => {
	const observed = { providerUsers: [] as string[][], toolsFinished: 0 };
	const tools: Tool[] = ["first", "second"].map((name) => ({
		name,
		description: name,
		parameters: { type: "object" },
		async execute() {
			observed.toolsFinished++;
			return `${name} result`;
		},
	}));
	const harness = createHarness(createConfig(tools), {
		stream: async function* (_model, messages) {
			observed.providerUsers.push(
				messages.filter((message) => message.role === "user").map((message) => message.content),
			);
			if (observed.providerUsers.length === 1) {
				yield { type: "delta", text: "working" };
				yield { type: "reasoning_delta", text: "thinking" };
				yield { type: "tool_call", callId: "call-1", name: "first", arguments: "{}" };
				yield { type: "tool_call", callId: "call-2", name: "second", arguments: "{}" };
			}
			yield { type: "done", reason: "stop", usage: { input: 2, output: 1, total: 3 } };
		},
	});
	const queued = {
		sessionId: "session-1",
		turnId: "turn-1",
		messageId: "message-2",
		text: "steer",
	};
	const steering = [queued];
	const events = await collectProtocolEvents(
		send(harness, "initial", undefined, () => {
			assert.equal(observed.toolsFinished, 2);
			return steering.shift();
		}),
	);
	const response = events.find((event) => event.type === "message_delta");
	assert(response);

	assert.deepEqual(
		events.map((event) => ({
			type: event.type,
			actor: event.actor,
			modelRole: "modelRole" in event ? event.modelRole : undefined,
			messageId: "messageId" in event ? event.messageId : undefined,
		})),
		[
			{ type: "message_delivered", actor: "human", modelRole: "user", messageId: "message-1" },
			{ type: "auth", actor: "process", modelRole: undefined, messageId: undefined },
			{ type: "message_delta", actor: "agent", modelRole: "assistant", messageId: response.messageId },
			{ type: "reasoning_delta", actor: "agent", modelRole: "assistant", messageId: response.messageId },
			{ type: "tool_call", actor: "agent", modelRole: "assistant", messageId: response.messageId },
			{ type: "tool_call", actor: "agent", modelRole: "assistant", messageId: response.messageId },
			{ type: "usage", actor: "process", modelRole: undefined, messageId: undefined },
			{ type: "tool_result", actor: "process", modelRole: "tool", messageId: undefined },
			{ type: "tool_result", actor: "process", modelRole: "tool", messageId: undefined },
			{ type: "message_delivered", actor: "human", modelRole: "user", messageId: "message-2" },
			{ type: "usage", actor: "process", modelRole: undefined, messageId: undefined },
			{ type: "end", actor: "process", modelRole: undefined, messageId: undefined },
		],
	);
	assert(events.every((event) => event.sessionId === "session-1" && event.turnId === "turn-1"));
	assert.deepEqual(observed.providerUsers, [["initial"], ["initial", "steer"]]);
});

test("admits steering in FIFO order one message per model boundary", async () => {
	const observed = { providerUsers: [] as string[][] };
	const harness = createHarness(createConfig(), {
		stream: async function* (_model, messages) {
			observed.providerUsers.push(
				messages.filter((message) => message.role === "user").map((message) => message.content),
			);
			yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
		},
	});
	const steering = ["second", "third"].map((text, index) => ({
		sessionId: "session-1",
		turnId: "turn-1",
		messageId: `message-${index + 2}`,
		text,
	}));
	const events = await collectProtocolEvents(send(harness, "first", undefined, () => steering.shift()));

	assert.deepEqual(
		events.filter((event) => event.type === "message_delivered").map((event) => event.messageId),
		["message-1", "message-2", "message-3"],
	);
	assert.deepEqual(observed.providerUsers, [["first"], ["first", "second"], ["first", "second", "third"]]);
});

test("waits through provider retry before delivering steering", async () => {
	const observed = { streamCalls: 0, users: [] as string[][] };
	const harness = createHarness(createConfig(), {
		stream: async function* (_model, messages) {
			observed.streamCalls++;
			observed.users.push(messages.filter((message) => message.role === "user").map((message) => message.content));
			if (observed.streamCalls === 1) {
				yield { type: "error", message: "retry", retryable: true, retryAfterMs: 0 };
				return;
			}
			yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
		},
	});
	const steering = {
		sessionId: "session-1",
		turnId: "turn-1",
		messageId: "message-2",
		text: "after retry",
	};
	const queue = [steering];
	const events = await collectProtocolEvents(send(harness, "first", undefined, () => queue.shift()));

	assert.deepEqual(observed.users, [["first"], ["first"], ["first", "after retry"]]);
	assert(
		events.findIndex((event) => event.type === "retry") <
			events.findIndex((event) => event.type === "message_delivered" && event.messageId === "message-2"),
	);
});

function createConfig(tools: Tool[] = []): EngineConfig {
	return {
		model: "test-model",
		getAuth: async () => ({ kind: "apikey", key: "test" }),
		tools,
		systemPrompt: "Test system prompt",
	};
}

async function collectEvents(events: AsyncIterable<Protocol.TurnEvent>): Promise<Array<Record<string, unknown>>> {
	const collected: Array<Record<string, unknown>> = [];
	for await (const event of events) {
		if (event.type !== "message_delivered" && event.type !== "assistant_message_completed") {
			collected.push(legacyEvent(event));
		}
	}
	return collected;
}

async function collectProtocolEvents(
	events: AsyncIterable<Protocol.TurnEvent>,
	includeCompletions = false,
): Promise<Protocol.TurnEvent[]> {
	const collected: Protocol.TurnEvent[] = [];
	for await (const event of events) {
		if (includeCompletions || event.type !== "assistant_message_completed") collected.push(event);
	}
	return collected;
}

function send(
	harness: ReturnType<typeof createHarness>,
	text: string,
	signal?: AbortSignal,
	takeSteering: TurnInput["takeSteering"] = () => undefined,
): AsyncIterable<Protocol.TurnEvent> {
	return harness.send(
		{
			initial: {
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "message-1",
				text,
			},
			takeSteering,
		},
		signal,
	);
}

function legacyEvent(event: Protocol.TurnEvent): Record<string, unknown> {
	const rest: Record<string, unknown> = { ...event };
	delete rest.actor;
	delete rest.modelRole;
	delete rest.sessionId;
	delete rest.turnId;
	if (event.type === "message_delta" || event.type === "reasoning_delta" || event.type === "tool_call") {
		delete rest.messageId;
	}
	if (event.type === "message_delta" || event.type === "reasoning_delta") delete rest.offset;
	const role = event.type === "tool_call" || event.type === "tool_result" ? "tool" : "assistant";
	return { role, ...rest };
}
