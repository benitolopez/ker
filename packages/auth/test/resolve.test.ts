import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { acquireLock } from "../src/lock.ts";
import { logout, resolveAuth } from "../src/resolve.ts";
import {
	type Credential,
	deleteCredentialUnlocked,
	readCredential,
	withAuthLock,
	writeCredentialUnlocked,
} from "../src/store.ts";

function jwt(accountId: string): string {
	const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${seg({ alg: "none" })}.${seg({ chatgpt_account_id: accountId })}.signature`;
}

function oauthCred(overrides: Partial<Credential>): Credential {
	return { type: "oauth", access: jwt("acc_old"), refresh: "r-old", expires: 0, accountId: "acc_old", ...overrides };
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

// Stub the token endpoint so a refresh returns a fresh JWT without touching the network. onCall
// runs before the response resolves, to interleave store mutations with an in-flight refresh; it
// must not await anything that needs the auth lock, which the refresh is holding.
function stubTokenEndpoint(body: object, onCall?: () => void): void {
	fetchCalls = 0;
	globalThis.fetch = async (): Promise<Response> => {
		fetchCalls++;
		onCall?.();
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
	writeCredentialUnlocked(oauthCred({ expires: Date.now() + 3_600_000 }));
	stubTokenEndpoint({});
	assert.deepEqual(await resolveAuth("sk-test"), { kind: "oauth", accessToken: jwt("acc_old"), accountId: "acc_old" });
	assert.equal(fetchCalls, 0);
});

test("refreshes an expired credential and persists the rotated tokens", async () => {
	writeCredentialUnlocked(oauthCred({ expires: Date.now() - 1000 }));
	stubTokenEndpoint({ access_token: jwt("acc_new"), refresh_token: "r-new", expires_in: 3600 });
	assert.deepEqual(await resolveAuth(), { kind: "oauth", accessToken: jwt("acc_new"), accountId: "acc_new" });
	assert.equal(fetchCalls, 1);
	assert.equal(readCredential()?.refresh, "r-new");
});

test("concurrent resolvers spend the refresh token once", async () => {
	writeCredentialUnlocked(oauthCred({ expires: Date.now() - 1000 }));
	stubTokenEndpoint({ access_token: jwt("acc_new"), refresh_token: "r-new", expires_in: 3600 });
	await Promise.all([resolveAuth(), resolveAuth()]);
	assert.equal(fetchCalls, 1);
});

test("a logout issued during a refresh lands after it and stays logged out", async () => {
	writeCredentialUnlocked(oauthCred({ expires: Date.now() - 1000 }));
	let logoutDone: Promise<void> = Promise.resolve();
	stubTokenEndpoint({ access_token: jwt("acc_new"), refresh_token: "r-new", expires_in: 3600 }, () => {
		logoutDone = logout();
	});
	assert.deepEqual(await resolveAuth(), { kind: "oauth", accessToken: jwt("acc_new"), accountId: "acc_new" });
	await logoutDone;
	assert.equal(readCredential(), undefined);
});

test("a login issued during a refresh wins the store", async () => {
	const newLogin = oauthCred({
		access: jwt("acc_new"),
		refresh: "r-other",
		expires: Date.now() + 3_600_000,
		accountId: "acc_new",
	});
	writeCredentialUnlocked(oauthCred({ expires: Date.now() - 1000 }));
	let loginDone: Promise<void> = Promise.resolve();
	stubTokenEndpoint({ access_token: jwt("acc_old"), refresh_token: "r-rotated", expires_in: 3600 }, () => {
		loginDone = withAuthLock(() => writeCredentialUnlocked(newLogin));
	});
	await resolveAuth();
	await loginDone;
	assert.deepEqual(readCredential(), newLogin);
});

test("falls back to the api key when a logout wins the lock before the refresh", async () => {
	writeCredentialUnlocked(oauthCred({ expires: Date.now() - 1000 }));
	stubTokenEndpoint({});
	const gate = await acquireLock(`${process.env.KER_AUTH_FILE}.lock`, 1000);
	const resolving = resolveAuth("sk-test");
	deleteCredentialUnlocked();
	gate.release();
	assert.deepEqual(await resolving, { kind: "apikey", key: "sk-test" });
	assert.equal(fetchCalls, 0);
});

test("a timed-out refresh releases the auth lock", async (t) => {
	writeCredentialUnlocked(oauthCred({ expires: Date.now() - 1000 }));
	t.mock.method(AbortSignal, "timeout", () =>
		AbortSignal.abort(new DOMException("The operation timed out", "TimeoutError")),
	);
	globalThis.fetch = async (_input, init): Promise<Response> => {
		assert.equal(init?.signal?.aborted, true);
		throw new DOMException("The operation timed out", "TimeoutError");
	};

	await assert.rejects(resolveAuth(), /OpenAI token refresh timed out after 45s/);
	const lock = await acquireLock(`${process.env.KER_AUTH_FILE}.lock`, 500);
	lock.release();
	await logout();
	assert.equal(readCredential(), undefined);
});
