import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock } from "./lock.ts";

const PROVIDER = "openai";

// Longer than the refresh request timeout in oauth.ts, so a waiter outlasts the longest
// legitimate hold.
const AUTH_LOCK_TIMEOUT_MS = 60_000;

export interface Credential {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
}

// Run fn holding the cross-process auth lock. Every credential mutation happens inside it (login,
// logout, and the whole expired-token refresh including its network call), so mutations are
// strictly ordered: once a logout returns, no refresh that started earlier can rewrite the store.
export async function withAuthLock<T>(fn: () => T | Promise<T>): Promise<T> {
	const lock = await acquireLock(`${authFilePath()}.lock`, AUTH_LOCK_TIMEOUT_MS);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

// The stored OpenAI credential, or undefined when the user has not logged in. Lock-free: writers
// replace the file atomically, so a plain read never sees a torn store.
export function readCredential(): Credential | undefined {
	return readStore()[PROVIDER];
}

export function writeCredentialUnlocked(cred: Credential): void {
	const store = readStore();
	store[PROVIDER] = cred;
	writeStore(store);
}

export function deleteCredentialUnlocked(): void {
	const store = readStore();
	if (!(PROVIDER in store)) return;
	delete store[PROVIDER];
	writeStore(store);
}

type Store = Record<string, Credential>;

function authFilePath(): string {
	if (process.env.KER_AUTH_FILE) return process.env.KER_AUTH_FILE;
	const dir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(dir, "ker", "auth.json");
}

// A missing file means the user is not logged in, so return an empty store. Malformed JSON throws.
function readStore(): Store {
	const path = authFilePath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	try {
		return JSON.parse(raw) as Store;
	} catch {
		throw new Error(`Invalid JSON in ${path}`);
	}
}

// The store is written to a temp file and renamed into place, so lock-free readers never see a
// partial file. The directory is 0700 and the file 0600 so only the user can read the stored
// tokens; chmod keeps that exact even under a restrictive umask.
function writeStore(store: Store): void {
	const path = authFilePath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}
