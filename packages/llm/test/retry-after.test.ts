import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRetryAfterMs } from "../src/index.ts";

test("returns undefined when there are no headers", () => {
	assert.equal(parseRetryAfterMs(undefined), undefined);
});

test("returns undefined when no retry-after header is present", () => {
	assert.equal(parseRetryAfterMs(new Headers()), undefined);
});

test("prefers retry-after-ms verbatim", () => {
	assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" })), 1500);
});

test("reads retry-after as seconds", () => {
	assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "2" })), 2000);
});

test("clamps a negative delay to zero", () => {
	assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "-5" })), 0);
});

test("clamps an HTTP-date already in the past to zero", () => {
	assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "Wed, 01 Jan 2020 00:00:00 GMT" })), 0);
});

test("returns undefined for an unparseable retry-after", () => {
	assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "soon" })), undefined);
});
