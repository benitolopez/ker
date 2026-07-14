import { createHash, randomBytes } from "node:crypto";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "ker";

export interface Pkce {
	verifier: string;
	challenge: string;
}

export interface TokenSet {
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
}

// PKCE S256: a random verifier and its base64url SHA-256 challenge.
export function generatePkce(): Pkce {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// The Codex login URL. The three extra params (id_token_add_organizations, codex_cli_simplified_flow,
// originator) are what the ChatGPT subscription flow expects. originator is set to "ker" rather than
// Codex's identifier, so requests are not disguised as the official client.
export function buildAuthorizeUrl(challenge: string, state: string): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", ORIGINATOR);
	return url.toString();
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: CLIENT_ID,
			code_verifier: verifier,
		}),
	});
	return readTokenResponse(res);
}

// The timeout bounds how long the auth lock is held by a refresh, so a hung token endpoint cannot
// keep login or logout waiting indefinitely. It must stay under the lock-wait timeout in store.ts.
const REFRESH_TIMEOUT_MS = 45_000;

export async function refreshToken(refresh: string): Promise<TokenSet> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
		signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
	}).catch((err: unknown) => {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new Error(`OpenAI token refresh timed out after ${REFRESH_TIMEOUT_MS / 1000}s`);
		}
		throw err;
	});
	return readTokenResponse(res, refresh);
}

// Read the ChatGPT account id from the access-token JWT payload (no signature check): the top-level
// claim, then the namespaced auth claim, then the first organization id.
export function decodeAccountId(accessToken: string): string {
	const parts = accessToken.split(".");
	if (parts.length !== 3) throw new Error("OpenAI access token is not a JWT");
	let claims: JwtClaims;
	try {
		claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
	} catch {
		throw new Error("could not decode the OpenAI access token");
	}
	const accountId =
		claims.chatgpt_account_id ??
		claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
		claims.organizations?.[0]?.id;
	if (!accountId)
		throw new Error("OpenAI access token carries no ChatGPT account id — is this a ChatGPT subscription?");
	return accountId;
}

// Accept whatever the user pastes back: a bare code, a `code=...&state=...` fragment, or the full
// redirect URL.
export function parseAuthInput(input: string): { code: string; state?: string } {
	const trimmed = input.trim();
	const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed;
	const params = new URLSearchParams(query);
	const code = params.get("code");
	if (code) return { code, state: params.get("state") ?? undefined };
	return { code: trimmed };
}

interface JwtClaims {
	chatgpt_account_id?: string;
	organizations?: Array<{ id: string }>;
	"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
}

// The token endpoint returns the same shape for the initial exchange and a refresh. A refresh may
// omit the rotated refresh token; keep the prior one when it does.
async function readTokenResponse(res: Response, priorRefresh?: string): Promise<TokenSet> {
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`OpenAI token endpoint returned ${res.status}${detail ? `: ${detail}` : ""}`);
	}
	const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
	const refresh = body.refresh_token ?? priorRefresh;
	if (!body.access_token || !refresh || typeof body.expires_in !== "number") {
		throw new Error("OpenAI token response was missing access_token, refresh_token, or expires_in");
	}
	return {
		access: body.access_token,
		refresh,
		expires: Date.now() + body.expires_in * 1000,
		accountId: decodeAccountId(body.access_token),
	};
}
