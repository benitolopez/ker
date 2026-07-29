import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("compact waits for success and prints the context reduction", async (t) => {
	const events: Protocol.Event[] = [
		{
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-compact",
			type: "compacted",
			summary: "summary",
			tokensBefore: 1_234,
			tokensAfter: 234,
			firstKeptEntryId: "entry-1",
		},
		terminal("completed"),
		end(),
	];
	const controlled = controlCompact(t, ["compact", "session-1"], events);

	await run();

	assert.equal(controlled.stderr.join(""), "ker: compacted (1,234 → 234 tokens)\n");
	assert.equal(controlled.stdout.join(""), "");
	assert.equal(process.exitCode, undefined);
	assert.deepEqual(controlled.paths, [
		"/health",
		"/sessions/session-1",
		"/sessions/session-1/events",
		"/sessions/session-1/compact",
	]);
});

test("compact reports a skip as a successful outcome", async (t) => {
	const controlled = controlCompact(
		t,
		["compact", "session-1"],
		[
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "turn-compact",
				type: "compaction_skipped",
				reason: "nothing_to_compact",
			},
			terminal("completed"),
			end(),
		],
	);

	await run();

	assert.equal(controlled.stderr.join(""), "ker: nothing to compact\n");
	assert.equal(process.exitCode, undefined);
});

test("compact reports when its turn is waiting behind existing work", async (t) => {
	const controlled = controlCompact(
		t,
		["compact", "session-1"],
		[
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "turn-compact",
				type: "compaction_skipped",
				reason: "nothing_to_compact",
			},
			terminal("completed"),
			end(),
		],
		"waiting",
	);

	await run();

	assert.equal(controlled.stderr.join(""), "ker: waiting (turn turn-compact)\nker: nothing to compact\n");
	assert.equal(process.exitCode, undefined);
});

test("compact reports provider errors and exits nonzero", async (t) => {
	const controlled = controlCompact(
		t,
		["compact", "session-1"],
		[
			{
				actor: "process",
				sessionId: "session-1",
				turnId: "turn-compact",
				type: "error",
				message: "summary failed",
			},
			terminal("error"),
			end(),
		],
	);

	await run();

	assert.equal(controlled.stderr.join(""), "ker: summary failed\n");
	assert.equal(process.exitCode, 1);
});

test("compact resolves the latest session and emits admission plus raw envelopes as JSON", async (t) => {
	const events: Protocol.Event[] = [
		{
			actor: "process",
			sessionId: "session-1",
			turnId: "turn-compact",
			type: "compaction_skipped",
			reason: "nothing_to_compact",
		},
		terminal("completed"),
		end(),
	];
	const controlled = controlCompact(t, ["--json", "compact"], events);

	await run();

	const lines = controlled.stdout.join("").trimEnd().split("\n");
	assert.deepEqual(JSON.parse(lines[0]) as Protocol.CompactionAdmission, admission());
	assert.deepEqual(
		lines.slice(1).map((line) => (JSON.parse(line) as Protocol.EventEnvelope).event.type),
		["compaction_skipped", "turn_terminal", "end"],
	);
	assert.deepEqual(controlled.paths.slice(0, 3), ["/health", "/sessions", "/health"]);
	assert.equal(controlled.stderr.join(""), "");
});

interface ControlledCompact {
	paths: string[];
	stderr: string[];
	stdout: string[];
}

function controlCompact(
	t: TestContext,
	args: string[],
	events: Protocol.Event[],
	status: Protocol.AdmissionStatus = "running",
): ControlledCompact {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const paths: string[] = [];
	const stderr: string[] = [];
	const stdout: string[] = [];
	const encoder = new TextEncoder();

	process.argv = [process.execPath, "ker", ...args];
	process.exitCode = undefined;
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	});
	globalThis.fetch = async (input): Promise<Response> => {
		const url = new URL(String(input));
		paths.push(url.pathname);
		if (url.pathname === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION }, 200);
		if (url.pathname === "/sessions") {
			return jsonResponse({ sessions: [snapshot().session], unreadable: [] }, 200);
		}
		if (url.pathname === "/sessions/session-1") return jsonResponse(snapshot(), 200);
		if (url.pathname === "/sessions/session-1/events") {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const [index, event] of events.entries()) {
							const envelope: Protocol.EventEnvelope = {
								epoch: "epoch-1",
								sequence: index + 1,
								event,
							};
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
						}
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}
		if (url.pathname === "/sessions/session-1/compact") return jsonResponse(admission(status), 202);
		throw new Error(`Unexpected request to ${url.pathname}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});

	return { paths, stderr, stdout };
}

function snapshot(): Protocol.SessionSnapshot {
	return {
		session: {
			id: "session-1",
			cwd: process.cwd(),
			projectRoot: process.cwd(),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		usage: {
			contextTokens: 100,
			cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		entries: [],
		messages: [],
		turns: [],
		queue: { revision: 0, waiting: [] },
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function admission(status: Protocol.AdmissionStatus = "running"): Protocol.CompactionAdmission {
	const item: Protocol.CompactionQueueItem = {
		id: "queue-compact",
		turnId: "turn-compact",
		kind: "compaction",
		source: "manual",
		state: status,
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
	return {
		status,
		sessionId: "session-1",
		turnId: "turn-compact",
		queueItemId: "queue-compact",
		queue: status === "running" ? { revision: 1, running: item, waiting: [] } : { revision: 1, waiting: [item] },
	};
}

function terminal(reason: Protocol.TurnTerminalReason): Protocol.TurnTerminalEvent {
	return {
		actor: "process",
		sessionId: "session-1",
		turnId: "turn-compact",
		type: "turn_terminal",
		reason,
	};
}

function end(): Protocol.EndEvent {
	return {
		actor: "process",
		sessionId: "session-1",
		turnId: "turn-compact",
		type: "end",
	};
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
