import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER = "openai";

export interface Credential {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
}

// The stored OpenAI credential, or undefined when the user has not logged in.
export function readCredential(): Credential | undefined {
	return readStore()[PROVIDER];
}

export function writeCredential(cred: Credential): void {
	const store = readStore();
	store[PROVIDER] = cred;
	writeStore(store);
}

export function deleteCredential(): void {
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

// The directory is 0700 and the file 0600 so only the user can read the stored tokens. writeFileSync
// ignores its mode argument when the file already exists, so chmod after every write.
function writeStore(store: Store): void {
	const path = authFilePath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}
