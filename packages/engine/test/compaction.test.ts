import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";
import { type CompactionOutcome, compactionSummaryMessage, createHarness, type EngineConfig } from "../src/index.ts";

const USAGE: Protocol.Usage = { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, total: 10 };

test("keeps an assistant cut point and its complete tool step", async () => {
	const messages: Llm.Message[] = [
		{ role: "user", content: "old".repeat(40) },
		{ role: "assistant", content: "old answer".repeat(20) },
		{ role: "user", content: "recent request" },
		{
			role: "assistant",
			content: "",
			toolCalls: [{ callId: "call-1", name: "read", arguments: "{}" }],
		},
		{ role: "tool", toolCallId: "call-1", content: "tool output".repeat(10) },
	];
	const harness = successfulHarness(messages);
	const result = await collect(harness.compact(request({ keepRecentTokens: 10 })));

	assert.equal(result.outcome.kind, "compacted");
	if (result.outcome.kind !== "compacted") return;
	assert.equal(result.outcome.keptCount, 2);
	assert.deepEqual(result.outcome.messages.slice(1), messages.slice(3));
});

test("skips a history smaller than the keep budget without resolving auth or streaming", async () => {
	const observed = { auth: 0, stream: 0 };
	const harness = createHarness(
		{
			...config(),
			getAuth: async () => {
				observed.auth++;
				return { kind: "apikey", key: "test" };
			},
		},
		{
			stream: async function* () {
				observed.stream++;
				yield { type: "error", message: "must not stream", retryable: false };
			},
		},
		{ messages: [{ role: "user", content: "short" }] },
	);

	const result = await collect(harness.compact(request({ keepRecentTokens: 100 })));

	assert.deepEqual(result, {
		events: [],
		outcome: { kind: "skipped", reason: "nothing_to_compact" },
	});
	assert.deepEqual(observed, { auth: 0, stream: 0 });
});

test("serializes roles while truncating tool arguments and results and omitting reasoning", async () => {
	const longArguments = "a".repeat(2_100);
	const longResult = "r".repeat(2_100);
	let prompt = "";
	let options: Llm.StreamOptions | undefined;
	const messages: Llm.Message[] = [
		{ role: "user", content: "old request" },
		{ role: "developer", content: "control text" },
		{
			role: "assistant",
			content: "working",
			toolCalls: [{ callId: "call-1", name: "write", arguments: longArguments }],
			reasoning: [{ encrypted_content: "must-not-appear" }],
		},
		{ role: "tool", toolCallId: "call-1", content: longResult },
		{ role: "user", content: "recent".repeat(40) },
		{ role: "assistant", content: "answer".repeat(40) },
	];
	const harness = createHarness(
		config(),
		{
			stream: async function* (_model, providerMessages, _auth, streamOptions) {
				const message = providerMessages[0];
				if (message.role === "user") prompt = message.content;
				options = streamOptions;
				yield { type: "delta", text: "summary" };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{ messages },
	);

	await collect(harness.compact(request({ keepRecentTokens: 20, reserveTokens: 100, maxOutputTokens: 50 })));

	assert.match(prompt, /^<conversation>\n\[User\]: old request/);
	assert.match(prompt, /\[Developer\]: control text/);
	assert.match(prompt, /\[Assistant\]: working/);
	assert.match(prompt, /\[Assistant tool calls\]: write\(a{2000}\n\n\[\.\.\. 100 more characters truncated\]\)/);
	assert.match(prompt, /\[Tool result\]: r{2000}\n\n\[\.\.\. 100 more characters truncated\]/);
	assert.doesNotMatch(prompt, /must-not-appear/);
	assert.equal(options?.instructions, "Summary system prompt");
	assert.equal(options?.maxOutputTokens, 50);
	assert.equal(options?.tools, undefined);
});

test("uses the update template, previous summary, and additional focus without serializing the old summary", async () => {
	let prompt = "";
	const harness = createHarness(
		config(),
		{
			stream: async function* (_model, messages) {
				const message = messages[0];
				if (message.role === "user") prompt = message.content;
				yield { type: "delta", text: "updated" };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{
			messages: [
				compactionSummaryMessage("old summary"),
				{ role: "user", content: "new work".repeat(50) },
				{ role: "assistant", content: "new result".repeat(50) },
			],
		},
	);

	await collect(
		harness.compact(
			request({
				keepRecentTokens: 20,
				previousSummary: "old summary",
				instructions: "focus on tests",
			}),
		),
	);

	assert.match(prompt, /<previous-summary>\nold summary\n<\/previous-summary>/);
	assert.match(prompt, /Update summary instructions/);
	assert.match(prompt, /Additional focus: focus on tests/);
	assert.equal(prompt.match(/old summary/g)?.length, 1);
});

test("retries a pre-output failure with fresh auth and yields summary usage", async () => {
	const observed = { auth: 0, streams: 0 };
	const harness = createHarness(
		{
			...config(),
			getAuth: async () => ({ kind: "apikey", key: `key-${++observed.auth}` }),
		},
		{
			stream: async function* () {
				observed.streams++;
				if (observed.streams === 1) {
					yield { type: "error", message: "retry", retryable: true, retryAfterMs: 0 };
					return;
				}
				yield { type: "delta", text: "summary" };
				yield { type: "done", reason: "length", usage: USAGE };
			},
		},
		{ messages: longHistory() },
	);

	const result = await collect(harness.compact(request()));

	assert.equal(result.outcome.kind, "compacted");
	assert.deepEqual(
		result.events.map((event) => event.type),
		["retry", "usage"],
	);
	assert.deepEqual(observed, { auth: 2, streams: 2 });
});

test("returns a non-mutating replacement with a developer summary and stripped kept usage", async () => {
	const messages: Llm.Message[] = [
		{ role: "user", content: "old".repeat(80) },
		{ role: "assistant", content: "old answer".repeat(40) },
		{ role: "user", content: "recent request" },
		{
			role: "assistant",
			content: "recent answer".repeat(20),
			provider: "openai",
			model: "test-model",
			usage: USAGE,
		},
	];
	const original = structuredClone(messages);
	const harness = successfulHarness(messages);

	const result = await collect(harness.compact(request({ keepRecentTokens: 10 })));

	assert.deepEqual(harness.messages, original);
	assert.equal(result.outcome.kind, "compacted");
	if (result.outcome.kind !== "compacted") return;
	assert.equal(result.outcome.messages[0].role, "developer");
	const kept = result.outcome.messages.at(-1);
	assert.equal(kept?.role, "assistant");
	if (kept?.role === "assistant") {
		assert.equal(kept.provider, undefined);
		assert.equal(kept.model, undefined);
		assert.equal(kept.usage, undefined);
	}
	assert.deepEqual(result.events, [
		{
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "usage",
			provider: "openai",
			model: "test-model",
			usage: USAGE,
		},
	]);
});

test("aborts a summary stream without changing history", async () => {
	const started = Promise.withResolvers<void>();
	const controller = new AbortController();
	const messages = longHistory();
	const harness = createHarness(
		config(),
		{
			stream: async function* (_model, _messages, _auth, options) {
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve();
						return;
					}
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				yield { type: "aborted" };
			},
		},
		{ messages },
	);

	const collecting = collect(harness.compact(request(), controller.signal));
	await started.promise;
	controller.abort();

	assert.deepEqual(await collecting, { events: [], outcome: { kind: "aborted" } });
	assert.deepEqual(harness.messages, messages);
});

test("yields a terminal error and stops when summarization fails", async () => {
	const harness = createHarness(
		config(),
		{
			stream: async function* () {
				yield { type: "error", message: "bad summary", retryable: false };
			},
		},
		{ messages: longHistory() },
	);

	const result = await collect(harness.compact(request()));

	assert.deepEqual(result, {
		events: [
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "turn-1",
				type: "error",
				message: "bad summary",
			},
		],
		outcome: { kind: "stopped" },
	});
});

test("rejects a changed identity before the summary call", async () => {
	let streams = 0;
	const harness = createHarness(
		{
			...config(),
			getAuth: async () => ({ kind: "oauth", accessToken: "new", accountId: "account-new" }),
		},
		{
			stream: async function* () {
				streams++;
				yield { type: "error", message: "must not stream", retryable: false };
			},
		},
		{ messages: longHistory(), identity: { kind: "oauth", accountId: "account-old" } },
	);

	const result = await collect(harness.compact(request()));

	assert.equal(result.outcome.kind, "stopped");
	assert.equal(streams, 0);
	assert.equal(result.events[0]?.type, "error");
	if (result.events[0]?.type === "error") assert.equal(result.events[0].code, "identity_changed");
});

function successfulHarness(messages: Llm.Message[]) {
	return createHarness(
		config(),
		{
			stream: async function* () {
				yield { type: "delta", text: "summary" };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{ messages },
	);
}

function config(): EngineConfig {
	return {
		model: "test-model",
		getAuth: async () => ({ kind: "apikey", key: "test" }),
		tools: [],
		systemPrompt: "System prompt",
		compaction: {
			systemPrompt: "Summary system prompt",
			initialInstructions: "Initial summary instructions",
			updateInstructions: "Update summary instructions",
		},
	};
}

function request(overrides: Partial<Parameters<ReturnType<typeof createHarness>["compact"]>[0]> = {}) {
	return {
		sessionId: "session-1",
		turnId: "turn-1",
		keepRecentTokens: 20,
		reserveTokens: 100,
		...overrides,
	};
}

function longHistory(): Llm.Message[] {
	return [
		{ role: "user", content: "old request".repeat(50) },
		{ role: "assistant", content: "old response".repeat(50) },
		{ role: "user", content: "recent request".repeat(10) },
		{ role: "assistant", content: "recent response".repeat(10) },
	];
}

async function collect(
	generator: AsyncGenerator<Protocol.TurnEvent, CompactionOutcome>,
): Promise<{ events: Protocol.TurnEvent[]; outcome: CompactionOutcome }> {
	const events: Protocol.TurnEvent[] = [];
	while (true) {
		const next = await generator.next();
		if (next.done) return { events, outcome: next.value };
		events.push(next.value);
	}
}
