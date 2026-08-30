import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { TranscriptStore } from "../src/store/transcript.ts";

test("rebuilds a structurally faithful transcript from a snapshot", () => {
	const store = new TranscriptStore();
	const value = snapshot();
	value.entries = [
		{
			id: "entry-user",
			parentId: null,
			turnId: "turn-1",
			messageId: "prompt-1",
			role: "user",
			content: "Inspect this",
		},
		{
			id: "entry-assistant",
			parentId: "entry-user",
			turnId: "turn-1",
			messageId: "answer-1",
			role: "assistant",
			content: "Done",
			reasoningSummary: "I inspected it.",
			toolCalls: [{ id: "call-1", name: "read", arguments: '{"path":"file.ts"}' }],
		},
		{
			id: "entry-tool",
			parentId: "entry-assistant",
			turnId: "turn-1",
			role: "tool",
			toolCallId: "call-1",
			content: "file contents",
		},
		{
			id: "entry-compaction",
			parentId: "entry-tool",
			turnId: "turn-compact",
			role: "compaction",
			summary: "Kept the decision.",
			tokensBefore: 100,
			tokensAfter: 20,
			firstKeptEntryId: "entry-user",
		},
	];
	value.messages = [
		{ id: "answer-1", turnId: "turn-1", text: "Done", reason: "completed" },
		{ id: "answer-2", turnId: "turn-2", text: "Unlinked", reason: "completed" },
	];
	value.active = { id: "answer-3", turnId: "turn-3", text: "Streaming" };
	value.queue = {
		revision: 2,
		waiting: [
			{
				id: "queue-1",
				turnId: "turn-4",
				kind: "prompt",
				messageId: "prompt-2",
				text: "Queued",
				state: "waiting",
				submittedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
	value.compactionFailure = { turnId: "turn-failed", message: "provider failed" };
	store.reset(value);

	const blocks = store
		.getSnapshot()
		.blockKeys.map((key) => store.getBlockSnapshot(key).block)
		.filter((block) => block !== undefined);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["prompt", "reasoning", "answer", "tool", "notice", "answer", "answer", "prompt", "notice"],
	);
	const tool = store.getBlockSnapshot("tool:call-1").block;
	assert.equal(tool?.kind, "tool");
	if (tool?.kind === "tool") assert.deepEqual(tool.result, { status: "ok", output: "file contents" });
	assert.equal(store.getBlockSnapshot("answer:answer-3").block?.kind, "answer");
	assert.equal(store.getSnapshot().header?.status, "waiting");
});

test("checks delta offsets, deduplicates envelopes, and wakes only the changed block", () => {
	const store = new TranscriptStore();
	store.reset(snapshot());
	let views = 0;
	let blocks = 0;
	store.subscribe(() => views++);
	store.apply(envelope(1, messageDelta(0, "hel")));
	store.subscribeBlock("answer:answer-live", () => blocks++);
	const viewsAfterCreation = views;
	store.apply(envelope(2, messageDelta(3, "lo")));
	store.apply(envelope(2, messageDelta(3, "lo")));
	store.apply(envelope(3, messageDelta(0, "hello")));

	assert.equal(views, viewsAfterCreation);
	assert.equal(blocks, 1);
	assert.deepEqual(store.getBlockSnapshot("answer:answer-live").block, {
		kind: "answer",
		key: "answer:answer-live",
		text: "hello",
		done: false,
	});
	assert.throws(() => store.apply(envelope(4, messageDelta(8, "gap"))), /Missing assistant output/);
});

test("pairs live tools and applies queue, usage, notices, and full resets", () => {
	const store = new TranscriptStore();
	store.reset(snapshot());
	store.apply(
		envelope(1, {
			actor: "agent",
			modelRole: "assistant",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "tool_call",
			messageId: "answer-live",
			id: "call-live",
			name: "bash",
			arguments: '{"command":"npm test"}',
		}),
	);
	store.apply(
		envelope(2, {
			actor: "process",
			modelRole: "tool",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "tool_result",
			id: "call-live",
			name: "bash",
			status: "error",
			output: "failed",
		}),
	);
	store.apply(
		envelope(3, {
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "usage",
			provider: "openai",
			model: "gpt-test",
			usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, total: 16 },
		}),
	);
	store.apply(
		envelope(4, {
			actor: "process",
			sessionId: "session-1",
			type: "queue_changed",
			queue: { revision: 2, waiting: [] },
		}),
	);
	store.apply(
		envelope(5, {
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "error",
			message: "model failed",
		}),
	);

	const tool = store.getBlockSnapshot("tool:call-live").block;
	assert.equal(tool?.kind, "tool");
	if (tool?.kind === "tool") assert.deepEqual(tool.result, { status: "error", output: "failed" });
	assert.equal(store.getSnapshot().header?.model?.id, "gpt-test");
	assert.equal(store.getSnapshot().header?.usage.cumulative.total, 16);
	assert.equal(store.getSnapshot().header?.status, "error");
	assert.equal(store.getSnapshot().queue.revision, 2);

	const replacement = snapshot();
	replacement.session.id = "session-2";
	store.reset(replacement);
	assert.deepEqual(store.getSnapshot().blockKeys, []);
	assert.equal(store.getSnapshot().header?.session.id, "session-2");
});

function snapshot(): Protocol.SessionSnapshot {
	return {
		session: {
			id: "session-1",
			cwd: "/project",
			projectRoot: "/project",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		model: { provider: "openai", id: "gpt-test", contextWindow: 100_000 },
		usage: {
			contextTokens: 10,
			cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		entries: [],
		messages: [],
		turns: [],
		queue: { revision: 0, waiting: [] },
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function envelope(sequence: number, event: Protocol.Event): Protocol.EventEnvelope {
	return { epoch: "epoch-1", sequence, event };
}

function messageDelta(offset: number, text: string): Protocol.MessageDeltaEvent {
	return {
		actor: "agent",
		modelRole: "assistant",
		sessionId: "session-1",
		turnId: "turn-1",
		type: "message_delta",
		messageId: "answer-live",
		offset,
		text,
	};
}
