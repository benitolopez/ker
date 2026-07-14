import type { Auth } from "@ker-ai/llm";
import { refreshToken } from "./oauth.ts";
import {
	type Credential,
	deleteCredentialUnlocked,
	readCredential,
	withAuthLock,
	writeCredentialUnlocked,
} from "./store.ts";

const EXPIRY_SKEW_MS = 60_000;

// Resolve the credential for a request: a stored OAuth login (refreshed if within a minute of expiry)
// takes precedence over the caller's API key. The store is read on every call, so a login saved after
// the daemon started is used without a restart. Throws only when neither a login nor an API key exists.
export async function resolveAuth(fallbackApiKey?: string): Promise<Auth> {
	const cred = readCredential();
	if (cred) {
		const auth = await resolveOAuth(cred);
		if (auth) return auth;
	}
	if (fallbackApiKey) return { kind: "apikey", key: fallbackApiKey };
	throw new Error('No credentials. Run `ker login`, set OPENAI_API_KEY, or add "apiKey" to ~/.config/ker/config.json.');
}

export async function logout(): Promise<void> {
	await withAuthLock(() => deleteCredentialUnlocked());
}

// Refresh an expired credential under the auth lock, re-reading the store after acquiring it: a
// concurrent resolver in this or another process may have refreshed first (its tokens are used
// without spending the rotating refresh token again), or a logout may have emptied the store
// (return undefined so the caller falls back). The lock is held across the network call, whose
// timeout bounds how long a login or logout can be kept waiting.
async function resolveOAuth(cred: Credential): Promise<Auth | undefined> {
	if (Date.now() < cred.expires - EXPIRY_SKEW_MS) {
		return { kind: "oauth", accessToken: cred.access, accountId: cred.accountId };
	}
	return withAuthLock(async () => {
		const current = readCredential();
		if (!current) return undefined;
		if (Date.now() < current.expires - EXPIRY_SKEW_MS) {
			return { kind: "oauth", accessToken: current.access, accountId: current.accountId };
		}
		const tokens = await refreshToken(current.refresh);
		writeCredentialUnlocked({
			type: "oauth",
			access: tokens.access,
			refresh: tokens.refresh,
			expires: tokens.expires,
			accountId: tokens.accountId,
		});
		return { kind: "oauth", accessToken: tokens.access, accountId: tokens.accountId };
	});
}
