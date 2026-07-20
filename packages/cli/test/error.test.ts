import assert from "node:assert/strict";
import { test } from "node:test";
import { identityChangeRemediation } from "../src/error.ts";

test("tells an oauth-bound conversation to log back in", () => {
	assert.equal(
		identityChangeRemediation({
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "error",
			code: "identity_changed",
			expected: { kind: "oauth", accountId: "acc_old" },
			actual: { kind: "oauth", accountId: "acc_new" },
			message: "identity changed",
		}),
		"log back into that account with `ker login`, or start a new conversation with `ker new`",
	);
});

test("tells an api-key-bound conversation to remove the oauth login", () => {
	assert.equal(
		identityChangeRemediation({
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "error",
			code: "identity_changed",
			expected: { kind: "apikey" },
			actual: { kind: "oauth", accountId: "acc_new" },
			message: "identity changed",
		}),
		"run `ker logout` to use the API key again, or start a new conversation with `ker new`",
	);
});

test("does not add remediation to an ordinary error", () => {
	assert.equal(
		identityChangeRemediation({
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "error",
			message: "provider failed",
		}),
		undefined,
	);
});
