import type { Auth } from "@ker-ai/llm";
import { refreshToken } from "./oauth.ts";
import { type Credential, deleteCredential, readCredential, writeCredential } from "./store.ts";

const EXPIRY_SKEW_MS = 60_000;

let refreshing: Promise<Auth> | undefined;

// Resolve the credential for a request: a stored OAuth login (refreshed if within a minute of expiry)
// takes precedence over the caller's API key. The store is read on every call, so a login saved after
// the daemon started is used without a restart. Throws only when neither a login nor an API key exists.
export async function resolveAuth(fallbackApiKey?: string): Promise<Auth> {
	const cred = readCredential();
	if (cred) return resolveOAuth(cred);
	if (fallbackApiKey) return { kind: "apikey", key: fallbackApiKey };
	throw new Error('No credentials. Run `ker login`, set OPENAI_API_KEY, or add "apiKey" to ~/.config/ker/config.json.');
}

export function logout(): void {
	deleteCredential();
}

// Concurrent turns share one in-flight refresh so the rotating refresh token is spent once.
async function resolveOAuth(cred: Credential): Promise<Auth> {
	if (Date.now() < cred.expires - EXPIRY_SKEW_MS) {
		return { kind: "oauth", accessToken: cred.access, accountId: cred.accountId };
	}
	if (!refreshing) {
		refreshing = refreshToken(cred.refresh)
			.then((tokens): Auth => {
				writeCredential({
					type: "oauth",
					access: tokens.access,
					refresh: tokens.refresh,
					expires: tokens.expires,
					accountId: tokens.accountId,
				});
				return { kind: "oauth", accessToken: tokens.access, accountId: tokens.accountId };
			})
			.finally(() => {
				refreshing = undefined;
			});
	}
	return refreshing;
}
