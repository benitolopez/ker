import { setTimeout as sleep } from "node:timers/promises";
import * as Daemon from "@ker-ai/daemon";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker-ai/protocol";
import { identityChangeRemediation } from "./error.ts";
import { runLogin, runLogout } from "./login.ts";
import { sseData } from "./sse.ts";

const BASE = `http://127.0.0.1:${DEFAULT_PORT}`;

interface ParsedPrompt {
	json: boolean;
	sessionId: Protocol.SessionId;
	text: string;
}

export async function run(): Promise<void> {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const positional = args.filter((arg) => arg !== "--json");
	if (positional.length === 1 && positional[0] === "daemon") {
		runDaemon();
		return;
	}
	if (positional.length === 1 && positional[0] === "login") {
		await runLogin();
		return;
	}
	if (positional.length === 1 && positional[0] === "logout") {
		await runLogout();
		return;
	}
	if (positional.length === 1 && positional[0] === "new") {
		await runNewSession(json);
		return;
	}
	if (positional.length === 1 && positional[0] === "sessions") {
		await runSessions(json);
		return;
	}
	if (positional[0] === "cancel" && positional.length === 2) {
		await runCancel(positional[1], json);
		return;
	}
	if (positional[0] === "monitor" && positional.length === 2) {
		await runMonitor(positional[1], json);
		return;
	}
	const prompt = parsePrompt(args);
	if (!prompt) {
		writeUsage();
		process.exitCode = 1;
		return;
	}
	await runPrompt(prompt);
}

async function runNewSession(json: boolean): Promise<void> {
	if (!(await checkHealth())) return;
	const res = await fetch(`${BASE}/sessions`, { method: "POST" });
	if (!res.ok) {
		process.stderr.write(`ker: daemon could not create a session (HTTP ${res.status})\n`);
		process.exitCode = 1;
		return;
	}
	const session = (await res.json()) as Protocol.SessionDescriptor;
	process.stdout.write(json ? `${JSON.stringify(session)}\n` : `${session.id}\n`);
}

async function runSessions(json: boolean): Promise<void> {
	if (!(await checkHealth())) return;
	const res = await fetch(`${BASE}/sessions`);
	if (!res.ok) {
		process.stderr.write(`ker: daemon could not list sessions (HTTP ${res.status})\n`);
		process.exitCode = 1;
		return;
	}
	const body = (await res.json()) as {
		sessions: Protocol.SessionDescriptor[];
		unreadable: Protocol.UnreadableSession[];
	};
	if (json) {
		process.stdout.write(`${JSON.stringify(body)}\n`);
		return;
	}
	for (const session of body.sessions) {
		process.stdout.write(`${session.id}\t${session.updatedAt}\t${session.cwd}\n`);
	}
	for (const session of body.unreadable) {
		process.stderr.write(`ker: session ${session.id} is unreadable — ${session.error}\n`);
	}
}

async function runCancel(sessionId: Protocol.SessionId, json: boolean): Promise<void> {
	if (!(await checkHealth())) return;
	const snapshotResponse = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`);
	if (snapshotResponse.status === 404) {
		process.stderr.write(`ker: session ${sessionId} was not found\n`);
		process.exitCode = 1;
		return;
	}
	if (!snapshotResponse.ok) {
		process.stderr.write(`ker: session ${sessionId} is unreadable (HTTP ${snapshotResponse.status})\n`);
		process.exitCode = 1;
		return;
	}
	const snapshot = (await snapshotResponse.json()) as Protocol.SessionSnapshot;
	const running = snapshot.queue.running;
	if (!running) {
		process.stderr.write(`ker: session ${sessionId} has no running turn to cancel\n`);
		process.exitCode = 1;
		return;
	}
	const response = await cancelTurn(sessionId, running.turnId);
	if (response.status === 409 || response.status === 404) {
		process.stderr.write(`ker: turn ${running.turnId} is no longer cancellable\n`);
		process.exitCode = 1;
		return;
	}
	if (!response.ok) {
		process.stderr.write(`ker: daemon could not cancel the turn (HTTP ${response.status})\n`);
		process.exitCode = 1;
		return;
	}
	const result = (await response.json()) as Protocol.TurnCancellationResult;
	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	writeTurnStatus(result.status, result.turnId);
}

// Signals stop new connections, abort the active turn cleanly, and leave waiting work persisted.
function runDaemon(): void {
	const server = Daemon.createDaemon();
	server.once("error", (error) => {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		process.stderr.write(`ker: port ${DEFAULT_PORT} is in use — is another ker daemon running?\n`);
		process.exitCode = 1;
	});
	server.listen(DEFAULT_PORT, "127.0.0.1", () => {
		process.stderr.write(`ker daemon listening on ${BASE}\n`);
	});
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		void (async () => {
			await server.shutdown();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		})();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

async function runMonitor(sessionId: Protocol.SessionId, json: boolean): Promise<void> {
	if (!(await checkHealth())) return;
	const controller = new AbortController();
	const renderer = new Renderer(true);
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);
	try {
		const initial = await fetchSnapshot(sessionId, controller.signal);
		if (!initial) return;
		if (json) process.stdout.write(`${JSON.stringify(initial)}\n`);
		if (!json) renderer.snapshot(initial, () => true, true, true);
		let idle = queueIsIdle(initial.queue);
		if (!json && idle) writeIdle();
		let cursor = initial.cursor;
		while (!controller.signal.aborted) {
			try {
				const events = await subscribe(sessionId, cursor, controller.signal);
				if (events.status === 410) {
					const snapshot = await fetchSnapshot(sessionId, controller.signal);
					if (!snapshot) return;
					if (json) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
					if (!json) renderer.snapshot(snapshot, () => true, true);
					const nextIdle = queueIsIdle(snapshot.queue);
					if (!json && nextIdle && !idle) writeIdle();
					idle = nextIdle;
					cursor = snapshot.cursor;
					continue;
				}
				if (!events.ok || !events.body) throw new Error(`event stream returned HTTP ${events.status}`);
				for await (const data of sseData(events.body)) {
					const envelope = JSON.parse(data) as Protocol.EventEnvelope;
					cursor = { epoch: envelope.epoch, sequence: envelope.sequence };
					if (json) process.stdout.write(`${data}\n`);
					if (!json) renderer.event(envelope.event, () => true);
					if (envelope.event.type === "queue_changed") {
						const nextIdle = queueIsIdle(envelope.event.queue);
						if (!json && nextIdle && !idle) writeIdle();
						idle = nextIdle;
					}
				}
			} catch (error) {
				if (controller.signal.aborted) break;
				process.stderr.write(
					`ker: monitor disconnected — ${error instanceof Error ? error.message : String(error)}; reconnecting\n`,
				);
				await sleep(1_000, undefined, { signal: controller.signal });
			}
		}
	} catch (error) {
		if (!controller.signal.aborted) {
			process.stderr.write(`ker: monitor failed — ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	} finally {
		process.off("SIGINT", onSigint);
	}
}

// A prompt subscribes before admission, waits through its session queue, and cancels only its exact turn.
async function runPrompt(prompt: ParsedPrompt): Promise<void> {
	const controller = new AbortController();
	const renderer = new Renderer();
	let accepted: Protocol.PromptAdmission | undefined;
	let cancelRequest: Promise<Response> | undefined;
	let interrupted = false;
	const onSigint = () => {
		if (interrupted) {
			process.exit(130);
			return;
		}
		interrupted = true;
		controller.abort();
		if (accepted) {
			cancelRequest = cancelTurn(accepted.sessionId, accepted.turnId);
		}
	};
	process.on("SIGINT", onSigint);
	try {
		if (!(await checkHealth(controller.signal))) return;
		const initial = await fetchSnapshot(prompt.sessionId, controller.signal);
		if (!initial) return;
		if (prompt.json) process.stdout.write(`${JSON.stringify(initial)}\n`);
		renderer.snapshot(initial, () => true, false, true);
		let cursor = initial.cursor;
		let events = await subscribe(prompt.sessionId, cursor, controller.signal);
		if (events.status === 410) {
			const replacement = await fetchSnapshot(prompt.sessionId, controller.signal);
			if (!replacement) return;
			if (prompt.json) process.stdout.write(`${JSON.stringify(replacement)}\n`);
			renderer.snapshot(replacement, () => true, false, true);
			cursor = replacement.cursor;
			events = await subscribe(prompt.sessionId, cursor, controller.signal);
		}
		if (!events.ok || !events.body) throw new Error(`event stream returned HTTP ${events.status}`);
		const submitted = await fetch(`${BASE}/sessions/${encodeURIComponent(prompt.sessionId)}/prompts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: prompt.text,
			}),
		});
		if (submitted.status !== 202) {
			process.stderr.write(
				submitted.status === 404
					? `ker: session ${prompt.sessionId} was not found\n`
					: `ker: daemon rejected the prompt (HTTP ${submitted.status})\n`,
			);
			process.exitCode = 1;
			return;
		}
		accepted = (await submitted.json()) as Protocol.PromptAdmission;
		if (interrupted && !cancelRequest) {
			cancelRequest = cancelTurn(accepted.sessionId, accepted.turnId);
		}
		if (accepted.status !== "running") {
			process.stderr.write(`ker: ${accepted.status} (turn ${accepted.turnId})\n`);
		}
		const matches = (turnId: Protocol.TurnId) => turnId === accepted?.turnId;
		let terminal = false;
		let failed = false;
		let cancelled = false;
		while (!terminal && !controller.signal.aborted) {
			try {
				if (!events.body) throw new Error("event stream has no body");
				for await (const data of sseData(events.body)) {
					const envelope = JSON.parse(data) as Protocol.EventEnvelope;
					cursor = { epoch: envelope.epoch, sequence: envelope.sequence };
					if (prompt.json) process.stdout.write(`${data}\n`);
					if (!prompt.json) renderer.event(envelope.event, matches);
					if (!("turnId" in envelope.event) || !matches(envelope.event.turnId)) continue;
					if (envelope.event.type === "turn_cancel_requested") cancelled = true;
					if (envelope.event.type === "error") {
						failed = true;
						if (!prompt.json) writeError(envelope.event);
					}
					if (envelope.event.type === "turn_terminal") {
						if (envelope.event.reason !== "completed") failed = true;
						if (envelope.event.reason === "aborted" || envelope.event.reason === "cancelled") cancelled = true;
					}
					if (envelope.event.type === "end") terminal = true;
					if (terminal) break;
				}
				if (terminal) break;
				const snapshot = await fetchSnapshot(prompt.sessionId, controller.signal);
				if (!snapshot) return;
				if (prompt.json) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
				if (!prompt.json) renderer.snapshot(snapshot, matches, true);
				cursor = snapshot.cursor;
				const turn = snapshot.turns.find((candidate) => matches(candidate.id));
				if (turn?.status === "cancelling" || turn?.status === "aborted" || turn?.status === "cancelled") {
					cancelled = true;
				}
				if (turn && turn.status !== "running" && turn.status !== "cancelling" && turn.status !== "waiting") {
					terminal = true;
					failed = turn.status !== "completed";
					break;
				}
				events = await subscribe(prompt.sessionId, cursor, controller.signal);
				if (events.status === 410) continue;
				if (!events.ok || !events.body) throw new Error(`event stream returned HTTP ${events.status}`);
			} catch (error) {
				if (controller.signal.aborted) break;
				process.stderr.write(
					`ker: event stream disconnected — ${error instanceof Error ? error.message : String(error)}; reconnecting\n`,
				);
				await sleep(1_000, undefined, { signal: controller.signal });
				const snapshot = await fetchSnapshot(prompt.sessionId, controller.signal);
				if (!snapshot) return;
				if (prompt.json) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
				if (!prompt.json) renderer.snapshot(snapshot, matches, true);
				cursor = snapshot.cursor;
				const turn = snapshot.turns.find((candidate) => matches(candidate.id));
				if (turn?.status === "cancelling" || turn?.status === "aborted" || turn?.status === "cancelled") {
					cancelled = true;
				}
				if (turn && turn.status !== "running" && turn.status !== "cancelling" && turn.status !== "waiting") {
					terminal = true;
					failed = turn.status !== "completed";
					break;
				}
				events = await subscribe(prompt.sessionId, cursor, controller.signal);
			}
		}
		if (cancelled) process.exitCode = 130;
		else if (failed) process.exitCode = 1;
	} catch (error) {
		if (!interrupted) {
			process.stderr.write(`ker: prompt failed — ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	} finally {
		if (cancelRequest) {
			try {
				const response = await cancelRequest;
				if (response.ok) {
					const result = (await response.json()) as Protocol.TurnCancellationResult;
					writeTurnStatus(result.status, result.turnId);
				} else if (response.status !== 409) {
					process.stderr.write(`ker: daemon could not cancel the turn (HTTP ${response.status})\n`);
				}
			} catch (error) {
				process.stderr.write(
					`ker: could not reach the daemon to cancel the turn — ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		}
		if (interrupted) process.exitCode = 130;
		process.off("SIGINT", onSigint);
	}
}

class Renderer {
	readonly #seen = new Map<Protocol.MessageId, number>();
	readonly #ended = new Set<Protocol.MessageId>();
	readonly #activeByTurn = new Map<Protocol.TurnId, Protocol.MessageId>();
	readonly #turnStatuses = new Map<Protocol.TurnId, Protocol.TurnSnapshot["status"]>();
	readonly #promptMessageIds = new Set<Protocol.MessageId>();
	readonly #developerEntryIds = new Set<string>();
	readonly #undeliveredMessageIds = new Set<Protocol.MessageId>();
	readonly #monitor: boolean;

	constructor(monitor = false) {
		this.#monitor = monitor;
	}

	snapshot(
		snapshot: Protocol.SessionSnapshot,
		matches: (turnId: Protocol.TurnId) => boolean,
		render: boolean,
		initial = false,
	): void {
		if (this.#monitor) this.#conversation(snapshot, matches, render);
		if (!this.#monitor) {
			for (const message of snapshot.messages) {
				if (!matches(message.turnId)) continue;
				this.#text(message.id, message.turnId, message.text, render);
				this.#finish(message.id, render);
			}
			if (snapshot.active && matches(snapshot.active.turnId)) {
				this.#text(snapshot.active.id, snapshot.active.turnId, snapshot.active.text, render);
			}
		}
		for (const turn of snapshot.turns) {
			if (!matches(turn.id)) continue;
			if (initial) {
				this.#turnStatuses.set(turn.id, turn.status);
				if (render && turn.status === "cancelling") writeTurnStatus(turn.status, turn.id);
				continue;
			}
			this.#transition(turn.id, turn.status);
		}
	}

	event(event: Protocol.Event, matches: (turnId: Protocol.TurnId) => boolean): void {
		if (!("turnId" in event) || !matches(event.turnId)) return;
		if (event.type === "turn_cancel_requested") this.#transition(event.turnId, "cancelling");
		if (event.type === "turn_terminal") this.#transition(event.turnId, event.reason);
		if (event.type === "message_delta") this.#text(event.messageId, event.turnId, event.text, true, event.offset);
		if (event.type === "assistant_message_completed") this.#finish(event.messageId, true);
		if (event.type === "error" || event.type === "aborted" || event.type === "interrupted") {
			const active = this.#activeByTurn.get(event.turnId);
			if (active) this.#finish(active, true);
		}
		if (!this.#monitor) return;
		if (event.type === "message_submitted" || event.type === "message_delivered") {
			this.#prompt(event.messageId, event.text, true);
		}
		if (event.type === "message_undelivered") {
			if (this.#undeliveredMessageIds.has(event.messageId)) return;
			this.#undeliveredMessageIds.add(event.messageId);
			process.stderr.write(`ker: prompt was not delivered: ${event.reason} (turn ${event.turnId})\n`);
		}
		if (event.type === "error") writeError(event);
	}

	#conversation(
		snapshot: Protocol.SessionSnapshot,
		matches: (turnId: Protocol.TurnId) => boolean,
		render: boolean,
	): void {
		const entries = snapshot.entries.filter((entry) => matches(entry.turnId));
		const messages = new Map(
			snapshot.messages.filter((message) => matches(message.turnId)).map((message) => [message.id, message]),
		);
		const linkedMessageIds = new Set(
			entries.flatMap((entry) => (entry.role === "assistant" && entry.messageId ? [entry.messageId] : [])),
		);
		const pendingByTurn = new Map<
			Protocol.TurnId,
			Array<Protocol.AssistantMessage | Protocol.ActiveAssistantMessage>
		>();
		for (const message of snapshot.messages) {
			if (!matches(message.turnId) || linkedMessageIds.has(message.id)) continue;
			pendingByTurn.set(message.turnId, [...(pendingByTurn.get(message.turnId) ?? []), message]);
		}
		if (snapshot.active && matches(snapshot.active.turnId)) {
			pendingByTurn.set(snapshot.active.turnId, [
				...(pendingByTurn.get(snapshot.active.turnId) ?? []),
				snapshot.active,
			]);
		}
		const flush = (turnId: Protocol.TurnId) => {
			const pending = pendingByTurn.get(turnId);
			if (!pending) return;
			for (const message of pending) {
				this.#text(message.id, message.turnId, message.text, render);
				if ("reason" in message) this.#finish(message.id, render);
			}
			pendingByTurn.delete(turnId);
		};

		for (const [index, entry] of entries.entries()) {
			if (entry.role === "user" && entry.messageId) {
				this.#prompt(entry.messageId, entry.content, render);
			}
			if (entry.role === "assistant" && entry.messageId) {
				const message = messages.get(entry.messageId);
				if (message) {
					this.#text(message.id, message.turnId, message.text, render);
					this.#finish(message.id, render);
				}
			}
			if (entry.role === "developer") {
				flush(entry.turnId);
				this.#developer(entry.id, entry.content, render);
			}
			if (entries[index + 1]?.turnId !== entry.turnId) flush(entry.turnId);
		}
		for (const turnId of pendingByTurn.keys()) flush(turnId);
		for (const item of [snapshot.queue.running, ...snapshot.queue.waiting]) {
			if (!item || !matches(item.turnId)) continue;
			this.#prompt(item.messageId, item.text, render);
		}
	}

	#transition(turnId: Protocol.TurnId, status: Protocol.TurnSnapshot["status"]): void {
		if (this.#turnStatuses.get(turnId) === status) return;
		this.#turnStatuses.set(turnId, status);
		if (status === "running" || status === "waiting" || status === "completed") return;
		writeTurnStatus(status, turnId);
	}

	#text(id: Protocol.MessageId, turnId: Protocol.TurnId, text: string, render: boolean, offset = 0): void {
		const seen = this.#seen.get(id) ?? 0;
		const end = offset + text.length;
		if (end <= seen) return;
		if (offset > seen) throw new Error(`Missing assistant output before offset ${offset}`);
		if (render) process.stdout.write(text.slice(seen - offset));
		this.#seen.set(id, end);
		this.#activeByTurn.set(turnId, id);
	}

	#finish(id: Protocol.MessageId, render: boolean): void {
		if (this.#ended.has(id)) return;
		if (render && (this.#seen.get(id) ?? 0) > 0) process.stdout.write("\n");
		this.#ended.add(id);
	}

	#prompt(id: Protocol.MessageId, text: string, render: boolean): void {
		if (this.#promptMessageIds.has(id) || this.#undeliveredMessageIds.has(id)) return;
		this.#promptMessageIds.add(id);
		if (render) writeAttributed("> ", text);
	}

	#developer(id: string, text: string, render: boolean): void {
		if (this.#developerEntryIds.has(id)) return;
		this.#developerEntryIds.add(id);
		if (render) writeAttributed("ker: ", text);
	}
}

function parsePrompt(args: string[]): ParsedPrompt | undefined {
	const values = args.filter((arg) => arg !== "--json");
	const json = values.length !== args.length;
	const sessionIndex = values.indexOf("--session");
	if (sessionIndex === -1 || !values[sessionIndex + 1]) return undefined;
	const sessionId = values[sessionIndex + 1];
	values.splice(sessionIndex, 2);
	const text = values.join(" ").trim();
	if (!text || values.some((value) => value.startsWith("--"))) return undefined;
	return { json, sessionId, text };
}

function queueIsIdle(queue: Protocol.QueueSnapshot): boolean {
	return !queue.running && queue.waiting.length === 0;
}

function writeIdle(): void {
	process.stderr.write("ker: waiting for turns\n");
}

function writeAttributed(prefix: string, text: string): void {
	const lines = text.endsWith("\n") ? text.split("\n").slice(0, -1) : text.split("\n");
	for (const line of lines) process.stderr.write(`${prefix}${line}\n`);
}

function writeError(event: Protocol.ErrorEvent): void {
	process.stderr.write(`ker: ${event.message}\n`);
	const remediation = identityChangeRemediation(event);
	if (remediation) process.stderr.write(`ker: ${remediation}\n`);
}

async function subscribe(
	sessionId: Protocol.SessionId,
	cursor: Protocol.Cursor,
	signal: AbortSignal,
): Promise<Response> {
	const query = new URLSearchParams({ epoch: cursor.epoch, sequence: String(cursor.sequence) });
	return fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/events?${query}`, { signal });
}

function cancelTurn(sessionId: Protocol.SessionId, turnId: Protocol.TurnId): Promise<Response> {
	return fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`, {
		method: "POST",
	});
}

function writeTurnStatus(
	status: Protocol.CancellationStatus | Exclude<Protocol.TurnTerminalReason, "completed">,
	turnId: string,
): void {
	process.stderr.write(`ker: ${status} (turn ${turnId})\n`);
}

async function fetchSnapshot(
	sessionId: Protocol.SessionId,
	signal?: AbortSignal,
): Promise<Protocol.SessionSnapshot | undefined> {
	const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, { signal });
	if (res.status === 404) {
		process.stderr.write(`ker: session ${sessionId} was not found\n`);
		process.exitCode = 1;
		return undefined;
	}
	if (!res.ok) throw new Error(`snapshot returned HTTP ${res.status}`);
	return (await res.json()) as Protocol.SessionSnapshot;
}

async function checkHealth(signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/health`, { signal });
		const health = (await res.json()) as { protocol?: string };
		if (health.protocol === PROTOCOL_VERSION) return true;
		if (signal?.aborted) return false;
		process.stderr.write(
			`ker: daemon speaks protocol ${health.protocol}, this client needs ${PROTOCOL_VERSION} — restart the daemon\n`,
		);
	} catch (error) {
		if (signal?.aborted) return false;
		const refused =
			error instanceof TypeError &&
			error.cause instanceof Error &&
			(error.cause as NodeJS.ErrnoException).code === "ECONNREFUSED";
		process.stderr.write(
			refused
				? "ker: daemon not running — start it with `ker daemon`\n"
				: `ker: could not reach the daemon — ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
	process.exitCode = 1;
	return false;
}

function writeUsage(): void {
	process.stderr.write(
		"usage: ker [--json] new | sessions | cancel <id> | monitor <id>\n       ker [--json] --session <id> <prompt>\n       ker daemon | login | logout\n",
	);
}
