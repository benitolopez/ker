import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";
import {
	type CompactionOutcome,
	compactionSummaryMessage,
	createHarness,
	type EngineConfig,
	estimateContextTokens,
	pruneToolOutputs,
	stripAssistantUsage,
} from "../src/index.ts";

const USAGE: Protocol.Usage = { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, total: 10 };
const PRUNED_OUTPUT_PLACEHOLDER =
	"[Old tool output removed to free context space. Re-read the file or re-run the command if you still need it.]";

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

	await collect(harness.compact(request({ keepRecentTokens: 20 })));

	assert.match(prompt, /^<conversation>\n\[User\]: old request/);
	assert.match(prompt, /\[Developer\]: control text/);
	assert.match(prompt, /\[Assistant\]: working/);
	assert.match(prompt, /\[Assistant tool calls\]: write\(a+\n\n\[\.\.\. \d+ characters truncated\]\n\na+\)/);
	assert.match(prompt, /\[Tool result\]: r+\n\n\[\.\.\. \d+ characters truncated\]\n\nr+/);
	const argumentStart = prompt.indexOf("write(") + "write(".length;
	const argumentEnd = prompt.indexOf(")\n\n[Tool result]");
	assert(argumentEnd - argumentStart <= 2_000);
	const resultStart = prompt.indexOf("[Tool result]: ") + "[Tool result]: ".length;
	const resultEnd = prompt.indexOf("\n\n[User]: recent");
	assert(resultEnd - resultStart <= 2_000);
	assert.doesNotMatch(prompt, /must-not-appear/);
	assert.equal(options?.instructions, "Summary system prompt");
	assert.equal(options?.maxOutputTokens, undefined);
	assert.equal(options?.tools, undefined);
});

test("truncates long user content head-and-tail within the message limit", async () => {
	const longUser = `HEAD-${"a".repeat(6_500)}MIDDLE-${"b".repeat(2_300)}-TAIL`;
	let prompt = "";
	const harness = createHarness(
		config(),
		{
			stream: async function* (_model, messages) {
				const message = messages[0];
				if (message.role === "user") prompt = message.content;
				yield { type: "delta", text: "summary" };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{
			messages: [
				{ role: "user", content: longUser },
				{ role: "assistant", content: "recent".repeat(20) },
			],
		},
	);

	await collect(harness.compact(request({ keepRecentTokens: 10 })));

	assert.match(prompt, /\[User\]: HEAD-/);
	assert.match(prompt, /-TAIL\n<\/conversation>/);
	assert.doesNotMatch(prompt, /MIDDLE/);
	assert.match(prompt, /\[\.\.\. \d+ characters truncated\]/);
	const serialized = prompt.slice("<conversation>\n[User]: ".length, prompt.indexOf("\n</conversation>"));
	assert(serialized.length <= 8_000);
});

test("omits the oldest serialized messages until the rendered prompt fits", async () => {
	const oldMessages: Llm.Message[] = Array.from({ length: 8 }, (_, index) => ({
		role: "user",
		content: `message-${index}-${"x".repeat(90)}`,
	}));
	let prompt = "";
	const harness = createHarness(
		config(),
		{
			stream: async function* (_model, messages) {
				const message = messages[0];
				if (message.role === "user") prompt = message.content;
				yield { type: "delta", text: "summary" };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{ messages: oldMessages },
	);

	await collect(harness.compact(request({ keepRecentTokens: 1, contextWindow: 200 })));

	const omitted = Number(prompt.match(/\[\.\.\. (\d+) earlier messages omitted/)?.[1]);
	assert(omitted > 0);
	for (let index = 0; index < 7; index++) {
		assert.equal(prompt.includes(`message-${index}-`), index >= omitted);
	}
	assert(prompt.length <= 400);
});

test("scales input headroom down for a small context window", async () => {
	let prompt = "";
	const harness = createHarness(
		config(),
		{
			stream: async function* (_model, messages) {
				const message = messages[0];
				if (message.role === "user") prompt = message.content;
				yield { type: "delta", text: "summary" };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{ messages: longHistory() },
	);

	const result = await collect(harness.compact(request({ contextWindow: 100 })));

	assert.equal(result.outcome.kind, "compacted");
	assert(prompt.length <= 200);
});

test("keeps the previous summary outside the droppable conversation budget", async () => {
	const previousSummary = "p".repeat(32_768);
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
				compactionSummaryMessage(previousSummary),
				{ role: "user", content: "old".repeat(10_000) },
				{ role: "assistant", content: "recent".repeat(20) },
			],
		},
	);

	const result = await collect(
		harness.compact(
			request({
				contextWindow: 20_000,
				keepRecentTokens: 10,
				previousSummary,
			}),
		),
	);

	assert.equal(result.outcome.kind, "compacted");
	assert.match(prompt, new RegExp(`<previous-summary>\\n${previousSummary}\\n</previous-summary>`));
	assert(prompt.length <= 40_000);
	assert.match(prompt, /earlier messages omitted|characters truncated/);
});

test("fails before streaming when fixed prompt content cannot fit", async () => {
	let streams = 0;
	const previousSummary = "p".repeat(32_768);
	const harness = createHarness(
		config(),
		{
			stream: async function* () {
				streams++;
				yield { type: "error", message: "must not stream", retryable: false };
			},
		},
		{
			messages: [
				compactionSummaryMessage(previousSummary),
				{ role: "user", content: "old".repeat(100) },
				{ role: "assistant", content: "recent".repeat(20) },
			],
		},
	);

	const result = await collect(
		harness.compact(
			request({
				contextWindow: 100,
				keepRecentTokens: 10,
				previousSummary,
			}),
		),
	);

	assert.equal(result.outcome.kind, "stopped");
	assert.equal(streams, 0);
	assert.equal(result.events[0]?.type, "error");
	if (result.events[0]?.type === "error") {
		assert.equal(result.events[0].message, "The summary request cannot fit the model context");
	}
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
				yield { type: "done", reason: "stop", usage: USAGE };
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

test("treats a length-limited summary as an error", async () => {
	const harness = createHarness(
		config(),
		{
			stream: async function* () {
				yield { type: "delta", text: "incomplete summary" };
				yield { type: "done", reason: "length", usage: USAGE };
			},
		},
		{ messages: longHistory() },
	);

	const result = await collect(harness.compact(request()));

	assert.equal(result.outcome.kind, "stopped");
	assert.deepEqual(
		result.events.map((event) => event.type),
		["usage", "error"],
	);
	const error = result.events.at(-1);
	assert.equal(error?.type, "error");
	if (error?.type === "error") assert.equal(error.message, "The summary hit the model's output limit");
});

test("rejects a summary above the hard size limit", async () => {
	const harness = createHarness(
		config(),
		{
			stream: async function* () {
				yield { type: "delta", text: "s".repeat(32_769) };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{ messages: longHistory() },
	);

	const result = await collect(harness.compact(request()));

	assert.equal(result.outcome.kind, "stopped");
	const error = result.events.at(-1);
	assert.equal(error?.type, "error");
	if (error?.type === "error") assert.match(error.message, /8192-token size limit/);
});

test("uses the compaction reasoning override and otherwise inherits the session effort", async () => {
	const observed: Array<Llm.ReasoningEffort | undefined> = [];
	const harness = createHarness(
		{ ...config(), reasoningEffort: "high" },
		{
			stream: async function* (_model, _messages, _auth, options) {
				observed.push(options?.reasoningEffort);
				yield { type: "delta", text: "summary" };
				yield { type: "done", reason: "stop", usage: USAGE };
			},
		},
		{ messages: longHistory() },
	);

	await collect(harness.compact(request({ reasoningEffort: "low" })));
	await collect(harness.compact(request()));

	assert.deepEqual(observed, ["low", "high"]);
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

test("computes the compaction gate pair with comparable normalized estimates", async () => {
	const anchoredUsage: Protocol.Usage = {
		input: 90_000,
		output: 10_000,
		cacheRead: 0,
		cacheWrite: 0,
		total: 100_000,
	};
	const messages: Llm.Message[] = [
		{ role: "user", content: "old request".repeat(60) },
		{
			role: "assistant",
			content: "old response".repeat(60),
			provider: "openai",
			model: "test-model",
			usage: anchoredUsage,
		},
		{ role: "user", content: "recent request".repeat(10) },
		{ role: "assistant", content: "recent response".repeat(10) },
	];
	const harness = successfulHarness(messages);

	const result = await collect(harness.compact(request({ keepRecentTokens: 20 })));

	assert.equal(result.outcome.kind, "compacted");
	if (result.outcome.kind !== "compacted") return;
	const normalized = messages.map(stripAssistantUsage);
	assert.equal(result.outcome.tokensBefore, estimateContextTokens(normalized));
	assert(result.outcome.tokensBefore < estimateContextTokens(messages));
});

test("prunes only worthwhile old tool output beyond the protected turns and token budget", () => {
	const messages = prunableHistory();
	const original = structuredClone(messages);

	const result = pruneToolOutputs(messages);

	assert(result);
	assert.deepEqual(result.toolCallIds, ["call-b", "call-a"]);
	assert.deepEqual(messages, original);
	assert(result.tokensAfter < result.tokensBefore);
	for (const message of result.messages) {
		if (message.role === "assistant") assert.equal(message.usage, undefined);
	}
	const tools = new Map(
		result.messages.flatMap((message) =>
			message.role === "tool" ? [[message.toolCallId, message.content] as const] : [],
		),
	);
	assert.equal(tools.get("call-a"), PRUNED_OUTPUT_PLACEHOLDER);
	assert.equal(tools.get("call-b"), PRUNED_OUTPUT_PLACEHOLDER);
	assert.notEqual(tools.get("call-c"), PRUNED_OUTPUT_PLACEHOLDER);
	assert.notEqual(tools.get("call-previous"), PRUNED_OUTPUT_PLACEHOLDER);
	assert.notEqual(tools.get("call-current"), PRUNED_OUTPUT_PLACEHOLDER);
});

test("does not prune when the comparable context reduction is below the minimum", () => {
	const messages: Llm.Message[] = [
		...toolTurn("small", 40_000),
		...toolTurn("protected", 160_000),
		{ role: "user", content: "previous" },
		{ role: "assistant", content: "previous answer" },
		{ role: "user", content: "current" },
		{ role: "assistant", content: "current answer" },
	];

	assert.equal(pruneToolOutputs(messages), undefined);
});

test("skips an existing prune placeholder without spending the protection budget", () => {
	const messages = prunableHistory().map((message) =>
		message.role === "tool" && message.toolCallId === "call-c"
			? { ...message, content: PRUNED_OUTPUT_PLACEHOLDER }
			: message,
	);

	const result = pruneToolOutputs(messages);

	assert(result);
	assert.deepEqual(result.toolCallIds, ["call-a"]);
	const existing = result.messages.find((message) => message.role === "tool" && message.toolCallId === "call-c");
	assert.equal(existing?.role, "tool");
	if (existing?.role === "tool") assert.equal(existing.content, PRUNED_OUTPUT_PLACEHOLDER);
});

test("fails closed when a selected tool call id is duplicated", () => {
	const messages = prunableHistory().map((message) =>
		message.role === "tool" && message.toolCallId === "call-current" ? { ...message, toolCallId: "call-b" } : message,
	);

	assert.equal(pruneToolOutputs(messages), undefined);
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

test("retries context overflow with geometrically smaller rendered prompts", async () => {
	const promptLengths: number[] = [];
	const messages: Llm.Message[] = [
		...Array.from({ length: 100 }, (_, index) => ({
			role: "user" as const,
			content: `${index}-${"x".repeat(7_998)}`,
		})),
		{ role: "assistant", content: "recent" },
	];
	const harness = createHarness(
		config(),
		{
			stream: async function* (_model, providerMessages) {
				const message = providerMessages[0];
				if (message.role === "user") promptLengths.push(message.content.length);
				yield {
					type: "error",
					message: "context_length_exceeded",
					retryable: false,
					contextOverflow: true,
				};
			},
		},
		{ messages },
	);

	const result = await collect(harness.compact(request({ keepRecentTokens: 1 })));

	assert.equal(result.outcome.kind, "stopped");
	assert.equal(promptLengths.length, 4);
	assert(promptLengths.every((length, index) => index === 0 || length < promptLengths[index - 1]));
	assert(promptLengths.every((length, index) => length <= Math.floor(400_000 / 2 ** index)));
	const error = result.events.at(-1);
	assert.equal(error?.type, "error");
	if (error?.type === "error") assert.equal(error.message, "context_length_exceeded");
});

test("stops overflow retries when the rendered prompt cannot shrink", async () => {
	let streams = 0;
	const harness = createHarness(
		config(),
		{
			stream: async function* () {
				streams++;
				yield {
					type: "error",
					message: "context_length_exceeded",
					retryable: false,
					contextOverflow: true,
				};
			},
		},
		{ messages: longHistory() },
	);

	const result = await collect(harness.compact(request()));

	assert.equal(result.outcome.kind, "stopped");
	assert.equal(streams, 1);
	assert.equal(result.events.at(-1)?.type, "error");
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

function prunableHistory(): Llm.Message[] {
	return [
		...toolTurn("a", 120_000),
		...toolTurn("b", 120_000),
		...toolTurn("c", 120_000),
		...toolTurn("previous", 120_000),
		...toolTurn("current", 120_000),
	];
}

function toolTurn(id: string, size: number): Llm.Message[] {
	return [
		{ role: "user", content: `request ${id}` },
		{
			role: "assistant",
			content: "",
			toolCalls: [{ callId: `call-${id}`, name: "read", arguments: "{}" }],
			provider: "openai",
			model: "test-model",
			usage: USAGE,
		},
		{ role: "tool", toolCallId: `call-${id}`, content: id.repeat(Math.ceil(size / id.length)).slice(0, size) },
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
