import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { NodeToPlaneFrame, PlaneToNodeFrame } from "../src/node.ts";

test("node socket schemas accept every frame family", () => {
	const identity = { id: "node-1", name: "laptop", createdAt: "2026-01-01T00:00:00.000Z" };
	const record = {
		version: 6,
		recordId: "record-1",
		previousRecordId: null,
		at: "2026-09-08T00:00:00.000Z",
		type: "session",
		session: { id: "session-1" },
	};
	const nodeFrames = [
		{ type: "enroll", token: "token", identity },
		{ type: "auth", nodeId: "node-1", secret: "secret" },
		{ type: "hello", nodeProtocol: "1", storeVersion: 6, running: [] },
		{ type: "records", sessionId: "session-1", records: [record] },
		{ type: "drained" },
		{
			type: "delta",
			sessionId: "session-1",
			event: {
				actor: "agent",
				modelRole: "assistant",
				sessionId: "session-1",
				turnId: "turn-1",
				type: "message_delta",
				messageId: "message-1",
				offset: 0,
				text: "hello",
			},
		},
		{ type: "load", id: "load-1", sessionId: "session-1" },
		{ type: "result", id: "call-1", value: { ok: true } },
		{ type: "error", id: "call-1", code: "internal", message: "failed" },
	];
	const planeFrames = [
		{ type: "welcome", nodeId: "node-1", secret: "secret" },
		{ type: "refused", code: "unauthorized", message: "no" },
		{ type: "ready", recover: ["session-1"] },
		{ type: "ack", sessionId: "session-1", recordId: "record-1" },
		{ type: "reject", sessionId: "session-1", recordId: "record-1", reason: "chain" },
		{ type: "call", id: "call-1", method: "admit", args: ["session-1", "hi"] },
		{ type: "chunk", id: "load-1", text: "{}\n" },
		{ type: "end", id: "load-1", found: true },
		{ type: "hb" },
	];
	assert(nodeFrames.every((frame) => Value.Check(NodeToPlaneFrame, frame)));
	assert(planeFrames.every((frame) => Value.Check(PlaneToNodeFrame, frame)));
});

test("node socket schemas reject unknown fields and frame types", () => {
	assert(!Value.Check(NodeToPlaneFrame, { type: "drained", extra: true }));
	assert(!Value.Check(PlaneToNodeFrame, { type: "hb", extra: true }));
	assert(!Value.Check(NodeToPlaneFrame, { type: "unknown" }));
});
