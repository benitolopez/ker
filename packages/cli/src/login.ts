import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as Auth from "@ker-ai/auth";

// `ker login`: run the OpenAI OAuth flow, opening the browser and, as a fallback, accepting a code
// pasted back into the terminal. The reply streams from the ChatGPT subscription once logged in.
export async function runLogin(): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const accountId = await Auth.login({
			onUrl: (url) => {
				process.stderr.write(`\nAuthorize ker with your ChatGPT subscription:\n\n  ${url}\n\n`);
				openBrowser(url);
				process.stderr.write("Waiting for the browser redirect — or paste the code/URL here and press enter.\n");
			},
			promptCode: () => new Promise((resolve) => rl.question("code: ", resolve)),
		});
		process.stderr.write(`\nLogged in to OpenAI (ChatGPT subscription, account ${accountId}).\n`);
	} catch (err) {
		process.stderr.write(`\nker: login failed — ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	} finally {
		// readline leaves stdin resumed; unref it so a finished login doesn't hold the process open.
		rl.close();
		process.stdin.unref();
	}
}

// `ker logout`: forget the stored OpenAI credential.
export async function runLogout(): Promise<void> {
	await Auth.logout();
	process.stderr.write("Logged out of OpenAI.\n");
}

// Open the URL in the platform browser, never through a shell. Failures (for example a headless box)
// are ignored, since the pasted-code path still completes the login.
function openBrowser(url: string): void {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	const child = spawn(command, args, { stdio: "ignore", detached: true });
	child.on("error", () => undefined);
	child.unref();
}
