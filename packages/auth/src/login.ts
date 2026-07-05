import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
	buildAuthorizeUrl,
	CALLBACK_PATH,
	CALLBACK_PORT,
	exchangeCode,
	generatePkce,
	parseAuthInput,
} from "./oauth.ts";
import { writeCredential } from "./store.ts";

export interface LoginCallbacks {
	onUrl: (url: string) => void | Promise<void>;
	promptCode?: () => Promise<string>;
}

// Run the browser OAuth flow. Hands the caller the authorize URL, then takes the code from whichever
// arrives first: the loopback redirect on :1455, or a code the user pastes back (for a headless box,
// or when :1455 is already bound). Persists the credential and returns the ChatGPT account id.
export async function login(callbacks: LoginCallbacks): Promise<string> {
	const pkce = generatePkce();
	const state = randomBytes(16).toString("hex");
	await callbacks.onUrl(buildAuthorizeUrl(pkce.challenge, state));

	const controller = new AbortController();
	try {
		const code = await Promise.race([
			waitForCallback(state, controller.signal),
			promptForCode(callbacks.promptCode, state),
		]);
		const tokens = await exchangeCode(code, pkce.verifier);
		writeCredential({
			type: "oauth",
			access: tokens.access,
			refresh: tokens.refresh,
			expires: tokens.expires,
			accountId: tokens.accountId,
		});
		return tokens.accountId;
	} finally {
		controller.abort();
	}
}

// Serve the loopback redirect on :1455 and resolve with the authorization code. A bound port or a
// headless box leaves this pending so the pasted code wins instead. On abort, close the server and
// destroy the browser's keep-alive socket — server.close() alone leaves it open and the process
// would not exit.
function waitForCallback(state: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get("code");
			if (!code || url.searchParams.get("state") !== state) {
				res.writeHead(400, { "content-type": "text/html" }).end(FAILURE_HTML);
				return;
			}
			res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_HTML);
			resolve(code);
		});
		server.on("error", () => undefined);
		server.listen(CALLBACK_PORT, "127.0.0.1");
		signal.addEventListener(
			"abort",
			() => {
				server.close();
				server.closeAllConnections();
			},
			{ once: true },
		);
	});
}

function promptForCode(prompt: (() => Promise<string>) | undefined, state: string): Promise<string> {
	if (!prompt) return new Promise<string>(() => undefined);
	return prompt().then((input) => {
		const parsed = parseAuthInput(input);
		if (parsed.state !== undefined && parsed.state !== state) {
			throw new Error("state in the pasted code did not match — run `ker login` again");
		}
		return parsed.code;
	});
}

const SUCCESS_HTML =
	'<!doctype html><meta charset="utf-8"><title>ker</title><body style="font-family:system-ui;text-align:center;padding-top:4rem"><h1>Logged in to ker</h1><p>You can close this tab and return to the terminal.</p></body>';
const FAILURE_HTML =
	'<!doctype html><meta charset="utf-8"><title>ker</title><body style="font-family:system-ui;text-align:center;padding-top:4rem"><h1>Login failed</h1><p>Return to the terminal and run <code>ker login</code> again.</p></body>';
