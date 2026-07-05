import assert from "node:assert/strict";
import { test } from "node:test";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { classifyError } from "../src/index.ts";

test("marks a connection timeout retryable with its own message", () => {
	const result = classifyError(new APIConnectionTimeoutError({ message: "timeout" }));
	assert.equal(result.retryable, true);
	assert.equal(result.message, "OpenAI request timed out");
});

test("marks a connection error retryable", () => {
	assert.equal(classifyError(new APIConnectionError({ message: "socket hang up" })).retryable, true);
});

test("treats 429 as retryable and surfaces retry-after", () => {
	const err = new APIError(429, undefined, "rate limited", new Headers({ "retry-after-ms": "1500" }));
	const result = classifyError(err);
	assert.equal(result.retryable, true);
	assert.equal(result.retryAfterMs, 1500);
});

test("treats 5xx as retryable", () => {
	const err = new APIError(503, undefined, "service unavailable", new Headers());
	assert.equal(classifyError(err).retryable, true);
});

test("treats auth and bad-request errors as terminal without a delay", () => {
	const unauthorized = classifyError(new APIError(401, undefined, "unauthorized", new Headers()));
	assert.equal(unauthorized.retryable, false);
	assert.equal(unauthorized.retryAfterMs, undefined);
	assert.equal(classifyError(new APIError(400, undefined, "bad request", new Headers())).retryable, false);
});

test("classifies a plain Error by matching its message", () => {
	assert.equal(classifyError(new Error("the model is overloaded")).retryable, true);
	assert.equal(classifyError(new Error("stream ended before a terminal response event")).retryable, true);
	assert.equal(classifyError(new Error("nonsense failure")).retryable, false);
});

test("falls back to stringifying a non-Error throw", () => {
	const result = classifyError("boom");
	assert.equal(result.message, "boom");
	assert.equal(result.retryable, false);
});
