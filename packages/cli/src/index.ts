import * as Daemon from "@ker-ai/daemon";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker-ai/protocol";
import { identityChangeRemediation } from "./error.ts";
import { runLogin, runLogout } from "./login.ts";
import { sseData } from "./sse.ts";

const BASE = `http://127.0.0.1:${DEFAULT_PORT}`;

// The `ker` bin: a leading `--json` dumps each raw event as JSON; otherwise only the assistant's
// answer streams to stdout. A sole command argument runs that operation; anything else is a prompt
// sent to the daemon.
export async function run(): Promise<void> {
	let args = process.argv.slice(2);
	const json = args[0] === "--json";
	if (json) args = args.slice(1);
	if (args.length === 1 && args[0] === "daemon") {
		runDaemon();
		return;
	}
	if (args.length === 1 && args[0] === "login") {
		await runLogin();
		return;
	}
	if (args.length === 1 && args[0] === "logout") {
		await runLogout();
		return;
	}
	if (args.length === 1 && args[0] === "new") {
		await runNewConversation();
		return;
	}
	const prompt = args.join(" ").trim();
	if (!prompt) {
		process.stderr.write("usage: ker [--json] <prompt> | ker daemon | ker login | ker logout | ker new\n");
		process.exitCode = 1;
		return;
	}
	await runPrompt(prompt, json);
}

async function runNewConversation(): Promise<void> {
	if (!(await checkHealth())) return;
	const res = await fetch(`${BASE}/conversation/new`, { method: "POST" });
	if (res.status === 201) {
		process.stderr.write("Started a new conversation.\n");
		return;
	}
	process.stderr.write(
		res.status === 409
			? "ker: daemon is busy — wait for the turn to finish before starting a new conversation\n"
			: `ker: daemon could not start a new conversation (HTTP ${res.status})\n`,
	);
	process.exitCode = 1;
}

// Host the daemon in the foreground, bound to loopback only — a bare listen(port) would expose
// the agent on every interface. Signals close all connections first: a plain close() waits
// forever on open SSE responses.
function runDaemon(): void {
	const server = Daemon.createDaemon();
	server.once("error", (err) => {
		if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
		process.stderr.write(`ker: port ${DEFAULT_PORT} is in use — is another ker daemon running?\n`);
		process.exitCode = 1;
	});
	server.listen(DEFAULT_PORT, "127.0.0.1", () => {
		process.stderr.write(`ker daemon listening on ${BASE}\n`);
	});
	const shutdown = () => {
		server.closeAllConnections();
		server.close();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

// Drive one turn through the daemon: health-check, subscribe to /event *before* POSTing so no events
// are missed, then consume the stream until the terminal `end` event. In the default mode
// only the assistant answer streams to stdout and fatal errors go to stderr; the other events
// (reasoning, tool calls, usage, auth, retry) are intentionally left unrendered — the TUI and `--json`
// are their surface. The first SIGINT requests exact-turn cancellation and waits for cleanup; a
// second exits immediately. With `json`, each raw event is echoed as one JSON line on stdout.
async function runPrompt(prompt: string, json: boolean): Promise<void> {
	const preSubmit = new AbortController();
	let submissionStarted = false;
	let abortRequested = false;
	let sessionId: Protocol.SessionId | undefined;
	let turnId: Protocol.TurnId | undefined;
	let abortRequest: Promise<{ kind: "response"; response: Response } | { kind: "error"; error: unknown }> | undefined;
	const requestAbort = () => {
		if (!abortRequested || !sessionId || !turnId || abortRequest) return;
		abortRequest = fetch(`${BASE}/turn/abort`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, turnId }),
		}).then(
			(response) => ({ kind: "response", response }),
			(error: unknown) => ({ kind: "error", error }),
		);
	};
	const onSigint = () => {
		if (abortRequested) {
			process.exit(130);
			return;
		}
		abortRequested = true;
		if (!submissionStarted) preSubmit.abort();
		requestAbort();
	};
	process.on("SIGINT", onSigint);

	try {
		const health = await checkHealth(preSubmit.signal);
		if (!health) {
			if (abortRequested) process.exitCode = 130;
			return;
		}
		if (abortRequested) {
			process.exitCode = 130;
			return;
		}
		sessionId = health.sessionId;

		const events = await fetch(`${BASE}/event`, { signal: preSubmit.signal });
		if (!events.ok || events.body === null) {
			process.stderr.write(`ker: could not subscribe to the event stream (HTTP ${events.status})\n`);
			process.exitCode = 1;
			return;
		}
		if (abortRequested) {
			await events.body.cancel();
			process.exitCode = 130;
			return;
		}

		submissionStarted = true;
		const submitted = await fetch(`${BASE}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: prompt, sessionId: health.sessionId }),
		});
		if (submitted.status !== 202) {
			await events.body.cancel();
			if (abortRequested) {
				process.exitCode = 130;
				return;
			}
			process.stderr.write(
				submitted.status === 409
					? "ker: daemon is busy with another turn\n"
					: submitted.status === 412
						? "ker: a new conversation was started before this prompt arrived — resubmit it\n"
						: `ker: daemon rejected the prompt (HTTP ${submitted.status})\n`,
			);
			process.exitCode = 1;
			return;
		}
		const accepted = (await submitted.json()) as { turnId?: unknown };
		if (typeof accepted.turnId !== "string") {
			await events.body.cancel();
			process.stderr.write("ker: daemon accepted the prompt without a turn id\n");
			process.exitCode = 1;
			return;
		}
		turnId = accepted.turnId;
		requestAbort();

		let streamed = false;
		let terminal = false;
		let aborted = false;
		for await (const data of sseData(events.body)) {
			const event = JSON.parse(data) as Protocol.Event;
			if (json) process.stdout.write(`${data}\n`);
			if (!json && event.type === "message_delta") {
				streamed = true;
				process.stdout.write(event.text);
			}
			if (event.type === "error") {
				if (!json) {
					process.stderr.write(`\nker: ${event.message}\n`);
					const remediation = identityChangeRemediation(event);
					if (remediation) process.stderr.write(`ker: ${remediation}\n`);
				}
				process.exitCode = 1;
			}
			if (event.type === "aborted") aborted = true;
			if (event.type === "end") {
				terminal = true;
				break;
			}
		}
		if (streamed) process.stdout.write("\n");
		if (!terminal) {
			process.stderr.write("ker: daemon closed the event stream mid-turn\n");
			process.exitCode = 1;
		}
		if (aborted) {
			if (!json) process.stderr.write("ker: aborted\n");
			process.exitCode = 130;
		}
		if (abortRequest) {
			const result = await abortRequest;
			if (result.kind === "error") {
				process.stderr.write(
					`ker: could not reach the daemon to abort the turn — ${result.error instanceof Error ? result.error.message : String(result.error)}\n`,
				);
				process.exitCode = 1;
			}
			if (result.kind === "response" && result.response.status !== 204 && result.response.status !== 409) {
				process.stderr.write(`ker: daemon could not abort the turn (HTTP ${result.response.status})\n`);
				process.exitCode = 1;
			}
		}
	} catch (error) {
		if (abortRequested && !submissionStarted) {
			process.exitCode = 130;
			return;
		}
		process.stderr.write(`ker: turn failed — ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

// Fail fast before subscribing: a refused connection means no daemon is running, and a protocol
// mismatch means a stale daemon from an older build is still up. On success returns the daemon's
// session id, which a prompt echoes back so a reset in between is detected. fetch
// buries the refusal as a TypeError whose cause carries the ECONNREFUSED code.
async function checkHealth(signal?: AbortSignal): Promise<{ sessionId: Protocol.SessionId } | undefined> {
	try {
		const res = await fetch(`${BASE}/health`, { signal });
		const health = (await res.json()) as { protocol?: string; sessionId?: unknown };
		if (health.protocol === PROTOCOL_VERSION && typeof health.sessionId === "string") {
			return { sessionId: health.sessionId };
		}
		if (signal?.aborted) return undefined;
		process.stderr.write(
			`ker: daemon speaks protocol ${health.protocol}, this client needs ${PROTOCOL_VERSION} — restart the daemon\n`,
		);
	} catch (err) {
		if (signal?.aborted) return undefined;
		const refused =
			err instanceof TypeError &&
			err.cause instanceof Error &&
			(err.cause as NodeJS.ErrnoException).code === "ECONNREFUSED";
		process.stderr.write(
			refused
				? "ker: daemon not running — start it with `ker daemon`\n"
				: `ker: could not reach the daemon — ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
	process.exitCode = 1;
	return undefined;
}
