import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildAuthorizeUrl, CLIENT_ID, decodeAccountId, generatePkce, parseAuthInput } from "../src/oauth.ts";

function jwt(payload: object): string {
	const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${seg({ alg: "none" })}.${seg(payload)}.signature`;
}

test("generatePkce derives an S256 challenge from the verifier", () => {
	const { verifier, challenge } = generatePkce();
	assert.match(verifier, /^[A-Za-z0-9_-]+$/);
	assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("buildAuthorizeUrl sets the Codex flow params with an honest originator", () => {
	const url = new URL(buildAuthorizeUrl("the-challenge", "the-state"));
	assert.equal(`${url.origin}${url.pathname}`, "https://auth.openai.com/oauth/authorize");
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
	assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
	assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
	assert.equal(url.searchParams.get("code_challenge"), "the-challenge");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("state"), "the-state");
	assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
	assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
	assert.equal(url.searchParams.get("originator"), "ker");
});

test("decodeAccountId reads the account id from each claim shape", () => {
	assert.equal(decodeAccountId(jwt({ chatgpt_account_id: "acc_top" })), "acc_top");
	assert.equal(decodeAccountId(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_ns" } })), "acc_ns");
	assert.equal(decodeAccountId(jwt({ organizations: [{ id: "org_first" }] })), "org_first");
});

test("decodeAccountId throws when there is no account id or the token is not a JWT", () => {
	assert.throws(() => decodeAccountId(jwt({ email: "x@y.z" })));
	assert.throws(() => decodeAccountId("not-a-jwt"));
});

test("parseAuthInput accepts a bare code, a query fragment, and the full redirect URL", () => {
	assert.deepEqual(parseAuthInput("  bare-code  "), { code: "bare-code" });
	assert.deepEqual(parseAuthInput("code=abc&state=xyz"), { code: "abc", state: "xyz" });
	assert.deepEqual(parseAuthInput("http://localhost:1455/auth/callback?code=abc&state=xyz"), {
		code: "abc",
		state: "xyz",
	});
});
