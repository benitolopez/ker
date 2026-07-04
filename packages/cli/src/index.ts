import type { ReadableStream } from "node:stream/web";
import * as Daemon from "@ker/daemon";
import type * as Protocol from "@ker/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker/protocol";

const BASE = `http://127.0.0.1:${DEFAULT_PORT}`;

// The `ker` bin: the sole argument `daemon` runs the daemon in the foreground; anything else is a
// prompt sent to it.
export async function run(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "daemon") {
		runDaemon();
		return;
	}
	const prompt = args.join(" ").trim();
	if (!prompt) {
		process.stderr.write("usage: ker <prompt> | ker daemon\n");
		process.exitCode = 1;
		return;
	}
	await runPrompt(prompt);
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

// Drive one turn through the daemon: health-check, subscribe to /event *before* POSTing so no
// events are missed, then print until a terminal event — `usage` or `error` ends the turn.
// Breaking the loop cancels the stream; no process.exit.
async function runPrompt(prompt: string): Promise<void> {
	if (!(await checkHealth())) return;

	const events = await fetch(`${BASE}/event`);
	if (!events.ok || events.body === null) {
		process.stderr.write(`ker: could not subscribe to the event stream (HTTP ${events.status})\n`);
		process.exitCode = 1;
		return;
	}

	const submitted = await fetch(`${BASE}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: prompt }),
	});
	if (submitted.status !== 202) {
		await events.body.cancel();
		process.stderr.write(
			submitted.status === 409
				? "ker: daemon is busy with another turn\n"
				: `ker: daemon rejected the prompt (HTTP ${submitted.status})\n`,
		);
		process.exitCode = 1;
		return;
	}

	let streamed = false;
	let terminal = false;
	for await (const data of sseData(events.body)) {
		const event = JSON.parse(data) as Protocol.Event;
		if (event.type === "message_delta") {
			streamed = true;
			process.stdout.write(event.text);
		}
		if (event.type === "usage") {
			process.stderr.write(`\n[tokens] in=${event.input} out=${event.output} total=${event.total}\n`);
			terminal = true;
		}
		// TODO: wire retry notices into the TUI when it lands.
		if (event.type === "retry") {
			const seconds = Math.ceil(event.delayMs / 1000);
			process.stderr.write(`ker: retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s — ${event.message}\n`);
		}
		if (event.type === "error") {
			process.stderr.write(`\nker: ${event.message}\n`);
			process.exitCode = 1;
			terminal = true;
		}
		if (terminal) break;
	}
	if (streamed) process.stdout.write("\n");
	if (!terminal) {
		process.stderr.write("ker: daemon closed the event stream mid-turn\n");
		process.exitCode = 1;
	}
}

// Fail fast before subscribing: a refused connection means no daemon is running, and a protocol
// mismatch means a stale daemon from an older build is still up. fetch buries the refusal as a
// TypeError whose cause carries the ECONNREFUSED code.
async function checkHealth(): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/health`);
		const health = (await res.json()) as { protocol?: string };
		if (health.protocol === PROTOCOL_VERSION) return true;
		process.stderr.write(
			`ker: daemon speaks protocol ${health.protocol}, this client needs ${PROTOCOL_VERSION} — restart the daemon\n`,
		);
	} catch (err) {
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
	return false;
}

// Parse an SSE byte stream into each event's data payload: buffer across chunk boundaries,
// tolerate CRLF, join multi-`data:` lines, and let comments (heartbeats) and id fields fall
// through. A consumer break propagates to the body's cancel via the generator's return().
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i).replace(/\r$/, "");
			buffer = buffer.slice(i + 1);
			if (line === "") {
				if (data.length > 0) yield data.join("\n");
				data = [];
				continue;
			}
			if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
	}
}
