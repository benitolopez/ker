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
// the daemon started is used without a restart. Throws when an OAuth credential cannot be refreshed or
// when neither a login nor an API key exists.
export async function resolveAuth(fallbackApiKey?: string, signal?: AbortSignal): Promise<Auth> {
	signal?.throwIfAborted();
	const cred = readCredential();
	if (cred) {
		const auth = await waitForAuth(resolveOAuth(cred, signal), signal);
		if (auth) return auth;
	}
	signal?.throwIfAborted();
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
async function resolveOAuth(cred: Credential, signal?: AbortSignal): Promise<Auth | undefined> {
	if (Date.now() < cred.expires - EXPIRY_SKEW_MS) {
		return { kind: "oauth", accessToken: cred.access, accountId: cred.accountId };
	}
	return withAuthLock(async () => {
		signal?.throwIfAborted();
		const current = readCredential();
		if (!current) return undefined;
		if (Date.now() < current.expires - EXPIRY_SKEW_MS) {
			return { kind: "oauth", accessToken: current.access, accountId: current.accountId };
		}
		signal?.throwIfAborted();
		const tokens = await refreshToken(current.refresh);
		writeCredentialUnlocked({
			type: "oauth",
			access: tokens.access,
			refresh: tokens.refresh,
			expires: tokens.expires,
			accountId: tokens.accountId,
		});
		return { kind: "oauth", accessToken: tokens.access, accountId: tokens.accountId };
	}, signal);
}

// Stop waiting for auth when a turn is aborted. The underlying refresh keeps its rejection handler
// and continues under the auth lock, so a rotating token is persisted even after the caller leaves.
function waitForAuth<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
