import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import type { Payload, StoredRecord } from "@ker-ai/store";
import { SessionProjection } from "../src/projection.ts";

const session: Protocol.SessionDescriptor = {
	id: "session-1",
	nodeId: "node-1",
	cwd: "/work/ker",
	projectRoot: "/work/ker",
	createdAt: "2026-09-08T00:00:00.000Z",
	updatedAt: "2026-09-08T00:00:00.000Z",
};

test("projects durable records and live deltas with replayable cursors", () => {
	const records = chain([
		{ type: "session", session },
		{
			type: "conversation",
			id: "entry-1",
			parentId: null,
			turnId: "turn-1",
			messageId: "user-1",
			message: { role: "user", content: "hello" },
		},
		{
			type: "event",
			event: {
				actor: "human",
				sessionId: session.id,
				turnId: "turn-1",
				type: "message_submitted",
				messageId: "user-1",
				queueItemId: "queue-1",
				text: "hello",
				admission: "running",
			},
		},
		{
			type: "stats",
			contextTokens: 42,
			model: { provider: "openai", id: "gpt-5.4-mini", contextWindow: 272_000 },
		},
	]);
	const projection = SessionProjection.load(records, 10);
	const cursor = projection.snapshot().cursor;
	const observed: Protocol.EventEnvelope[] = [];
	const subscription = projection.subscribe(cursor, (envelope) => observed.push(envelope));
	assert.notEqual(subscription, "resync");
	projection.applyDelta({
		actor: "agent",
		modelRole: "assistant",
		sessionId: session.id,
		turnId: "turn-1",
		type: "message_delta",
		messageId: "assistant-1",
		offset: 0,
		text: "answer",
	});

	const snapshot = projection.snapshot();
	assert.equal(snapshot.entries[0]?.role, "user");
	assert.equal(snapshot.model?.id, "gpt-5.4-mini");
	assert.equal(snapshot.usage.contextTokens, 42);
	assert.equal(snapshot.active?.text, "answer");
	assert.equal(observed.length, 1);
	const replay = projection.subscribe(cursor, () => undefined);
	assert.notEqual(replay, "resync");
	if (replay !== "resync") assert.deepEqual(replay.replay, observed);
	if (subscription !== "resync") subscription.unsubscribe();
});

test("derives and clears automatic compaction failures", () => {
	const projection = SessionProjection.load(
		chain([
			{ type: "session", session },
			{
				type: "event",
				event: {
					actor: "process",
					sessionId: session.id,
					turnId: "turn-compact",
					type: "compaction_submitted",
					queueItemId: "queue-compact",
					source: "auto",
					admission: "running",
				},
			},
			{
				type: "event",
				event: {
					actor: "process",
					sessionId: session.id,
					turnId: "turn-compact",
					type: "error",
					message: "too large",
				},
			},
		]),
		10,
	);
	assert.equal(projection.snapshot().compactionFailure?.message, "too large");
	projection.apply(
		chain([
			{
				type: "event",
				event: {
					actor: "process",
					sessionId: session.id,
					turnId: "turn-compact",
					type: "compacted",
					summary: "summary",
					tokensBefore: 100,
					tokensAfter: 20,
					firstKeptEntryId: "entry-1",
				},
			},
		]),
	);
	assert.equal(projection.snapshot().compactionFailure, undefined);
});

function chain(payloads: Payload[]): StoredRecord[] {
	return payloads.map((payload, index) => ({
		...payload,
		version: 6,
		recordId: `record-${index}`,
		previousRecordId: index === 0 ? null : `record-${index - 1}`,
		at: `2026-09-08T00:00:0${index}.000Z`,
	})) as StoredRecord[];
}
