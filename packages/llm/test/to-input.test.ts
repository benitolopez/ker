import assert from "node:assert/strict";
import { test } from "node:test";
import { toInput } from "../src/index.ts";

test("maps a user message to a user input item", () => {
	assert.deepEqual(toInput([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
});

test("replays an assistant turn as reasoning, then text, then function calls in order", () => {
	const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] };
	const items = toInput([
		{
			role: "assistant",
			content: "let me look",
			reasoning: [reasoning],
			toolCalls: [{ callId: "call_1", itemId: "fc_1", name: "read", arguments: '{"path":"a.ts"}' }],
		},
	]);
	assert.deepEqual(items, [
		reasoning,
		{ role: "assistant", content: "let me look" },
		{ type: "function_call", call_id: "call_1", id: "fc_1", name: "read", arguments: '{"path":"a.ts"}' },
	]);
});

test("omits the assistant text item when there is no text", () => {
	const items = toInput([
		{ role: "assistant", content: "", toolCalls: [{ callId: "call_1", name: "read", arguments: "{}" }] },
	]);
	assert.deepEqual(items, [{ type: "function_call", call_id: "call_1", id: undefined, name: "read", arguments: "{}" }]);
});

test("maps a tool result to a function_call_output keyed by the call id", () => {
	assert.deepEqual(toInput([{ role: "tool", toolCallId: "call_1", content: "file body" }]), [
		{ type: "function_call_output", call_id: "call_1", output: "file body" },
	]);
});
