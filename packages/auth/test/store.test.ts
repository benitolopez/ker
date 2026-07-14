import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type Credential, deleteCredentialUnlocked, readCredential, writeCredentialUnlocked } from "../src/store.ts";

const cred: Credential = { type: "oauth", access: "a-token", refresh: "r-token", expires: 123, accountId: "acc" };

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ker-auth-"));
	file = join(dir, "auth.json");
	process.env.KER_AUTH_FILE = file;
});

afterEach(() => {
	delete process.env.KER_AUTH_FILE;
	rmSync(dir, { recursive: true, force: true });
});

test("reads undefined before any login", () => {
	assert.equal(readCredential(), undefined);
});

test("round-trips a written credential", () => {
	writeCredentialUnlocked(cred);
	assert.deepEqual(readCredential(), cred);
});

test("writes the credential file 0600", () => {
	writeCredentialUnlocked(cred);
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("deleteCredentialUnlocked forgets the login", () => {
	writeCredentialUnlocked(cred);
	deleteCredentialUnlocked();
	assert.equal(readCredential(), undefined);
});
