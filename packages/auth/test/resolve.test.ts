import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveAuth } from "../src/resolve.ts";
import { type Credential, readCredential, writeCredential } from "../src/store.ts";

function jwt(accountId: string): string {
	const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${seg({ alg: "none" })}.${seg({ chatgpt_account_id: accountId })}.signature`;
}

function oauthCred(overrides: Partial<Credential>): Credential {
	return { type: "oauth", access: jwt("acc_old"), refresh: "r-old", expires: 0, accountId: "acc_old", ...overrides };
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

// Stub the token endpoint so a refresh returns a fresh JWT without touching the network.
function stubTokenEndpoint(body: object): void {
	fetchCalls = 0;
	globalThis.fetch = async (): Promise<Response> => {
		fetchCalls++;
		return new Response(JSON.stringify(body), { status: 200 });
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ker-auth-"));
	process.env.KER_AUTH_FILE = join(dir, "auth.json");
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.KER_AUTH_FILE;
	rmSync(dir, { recursive: true, force: true });
});

test("falls back to the api key when there is no login", async () => {
	assert.deepEqual(await resolveAuth("sk-test"), { kind: "apikey", key: "sk-test" });
});

test("throws when neither a login nor an api key is available", async () => {
	await assert.rejects(resolveAuth());
});

test("uses a valid oauth credential without refreshing", async () => {
	writeCredential(oauthCred({ expires: Date.now() + 3_600_000 }));
	stubTokenEndpoint({});
	assert.deepEqual(await resolveAuth("sk-test"), { kind: "oauth", accessToken: jwt("acc_old"), accountId: "acc_old" });
	assert.equal(fetchCalls, 0);
});

test("refreshes an expired credential and persists the rotated tokens", async () => {
	writeCredential(oauthCred({ expires: Date.now() - 1000 }));
	stubTokenEndpoint({ access_token: jwt("acc_new"), refresh_token: "r-new", expires_in: 3600 });
	assert.deepEqual(await resolveAuth(), { kind: "oauth", accessToken: jwt("acc_new"), accountId: "acc_new" });
	assert.equal(fetchCalls, 1);
	assert.equal(readCredential()?.refresh, "r-new");
});

test("shares one in-flight refresh across concurrent callers", async () => {
	writeCredential(oauthCred({ expires: Date.now() - 1000 }));
	stubTokenEndpoint({ access_token: jwt("acc_new"), refresh_token: "r-new", expires_in: 3600 });
	await Promise.all([resolveAuth(), resolveAuth()]);
	assert.equal(fetchCalls, 1);
});
