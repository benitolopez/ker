import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("a bare prompt creates a session and prints only the answer", async (t) => {
	const controlled = controlPrompt(t, { args: ["hello"] });
	const running = run();
	await controlled.promptStarted.promise;
	controlled.complete();
	await running;

	assert.deepEqual(controlled.createBodies, [{ cwd: process.cwd() }]);
	assert.deepEqual(controlled.promptBodies, [{ text: "hello" }]);
	assert.deepEqual(controlled.promptSessionIds, ["session-1"]);
	assert.equal(controlled.stdout.join(""), "answer\n");
	assert.equal(controlled.stderr.join(""), "");
});

test("a JSON bare prompt prints the new session snapshot before event envelopes", async (t) => {
	const controlled = controlPrompt(t, { args: ["--json", "hello"] });
	const running = run();
	await controlled.promptStarted.promise;
	controlled.complete();
	await running;

	const lines = controlled.stdout
		.join("")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Protocol.SessionSnapshot | Protocol.EventEnvelope);
	assert.deepEqual(lines[0], snapshot(descriptor("session-1")));
	assert.deepEqual(
		lines.slice(1).map((line) => (line as Protocol.EventEnvelope).event.type),
		["message_delta", "assistant_message_completed", "turn_terminal", "end"],
	);
	assert.equal(controlled.stderr.join(""), "");
});

test("a prompt reports an outstanding compaction failure without touching the answer", async (t) => {
	const compactionFailure = { turnId: "turn-compact", message: "Compacted context is still too close" };
	const controlled = controlPrompt(t, { args: ["hello"], compactionFailure });
	const running = run();
	await controlled.promptStarted.promise;
	controlled.complete();
	await running;

	assert.equal(
		controlled.stderr.join(""),
		"ker: last automatic compaction failed — Compacted context is still too close\n",
	);
	assert.equal(controlled.stdout.join(""), "answer\n");
	assert.equal(process.exitCode, undefined);
});

test("a JSON prompt leaves an outstanding compaction failure to the snapshot it prints", async (t) => {
	const compactionFailure = { turnId: "turn-compact", message: "Compacted context is still too close" };
	const controlled = controlPrompt(t, { args: ["--json", "hello"], compactionFailure });
	const running = run();
	await controlled.promptStarted.promise;
	controlled.complete();
	await running;

	assert.equal(controlled.stderr.join(""), "");
	const first = JSON.parse(controlled.stdout.join("").trim().split("\n")[0]) as Protocol.SessionSnapshot;
	assert.deepEqual(first.compactionFailure, compactionFailure);
});

test("an exhausted context is refused with a way out rather than a bare status", async (t) => {
	const controlled = controlPrompt(t, {
		args: ["hello"],
		promptRejection: { status: 409, body: { code: "context_exhausted" } },
	});

	await run();

	assert.equal(
		controlled.stderr.join(""),
		"ker: this session's context is full and could not be compacted — start a new session with `ker new`, or try `ker compact`\n",
	);
	assert.equal(controlled.stdout.join(""), "");
	assert.equal(process.exitCode, 1);
});

test("an unexplained rejection still reports its status", async (t) => {
	const controlled = controlPrompt(t, { args: ["hello"], promptRejection: { status: 409, body: {} } });

	await run();

	assert.equal(controlled.stderr.join(""), "ker: daemon rejected the prompt (HTTP 409)\n");
	assert.equal(process.exitCode, 1);
});

test("a bare prompt stops when session creation fails", async (t) => {
	const controlled = controlPrompt(t, { args: ["hello"], createStatus: 500 });

	await run();

	assert.equal(controlled.stderr.join(""), "ker: daemon could not create a session (HTTP 500)\n");
	assert.equal(process.exitCode, 1);
	assert.equal(
		controlled.paths.some((path) => path.endsWith("/prompts")),
		false,
	);
});

test("-c and --continue select the greatest updatedAt rather than list order", async (t) => {
	const sessions = [
		descriptor("session-newer", "2026-01-03T00:00:00.000Z"),
		descriptor("session-older", "2026-01-02T00:00:00.000Z"),
	];
	for (const flag of ["-c", "--continue"]) {
		await t.test(flag, async (t) => {
			const controlled = controlPrompt(t, { args: [flag, "hello"], sessions });
			const running = run();
			await controlled.promptStarted.promise;
			controlled.complete();
			await running;

			assert.deepEqual(controlled.listCwds, [process.cwd()]);
			assert.deepEqual(controlled.promptSessionIds, ["session-newer"]);
			assert.equal(controlled.stdout.join(""), "answer\n");
		});
	}
});

test("-c resolves an updatedAt tie to the later-created list entry", async (t) => {
	const updatedAt = "2026-01-03T00:00:00.000Z";
	const controlled = controlPrompt(t, {
		args: ["-c", "hello"],
		sessions: [descriptor("session-first", updatedAt), descriptor("session-second", updatedAt)],
	});
	const running = run();
	await controlled.promptStarted.promise;
	controlled.complete();
	await running;

	assert.deepEqual(controlled.promptSessionIds, ["session-second"]);
});

test("-c reports when the current directory has no sessions", async (t) => {
	const controlled = controlPrompt(t, { args: ["-c", "hello"], sessions: [] });

	await run();

	assert.match(controlled.stderr.join(""), /ker: no session for .* — start one with `ker <prompt>` or `ker new`/);
	assert.equal(process.exitCode, 1);
	assert.equal(
		controlled.paths.some((path) => path.endsWith("/prompts")),
		false,
	);
});

interface ControlledPrompt {
	createBodies: Protocol.CreateSessionRequest[];
	listCwds: Array<string | null>;
	paths: string[];
	promptBodies: Array<{ text: string }>;
	promptSessionIds: string[];
	promptStarted: PromiseWithResolvers<void>;
	stderr: string[];
	stdout: string[];
	complete(): void;
}

function controlPrompt(
	t: TestContext,
	options: {
		args: string[];
		createStatus?: number;
		sessions?: Protocol.SessionDescriptor[];
		compactionFailure?: Protocol.CompactionFailure;
		promptRejection?: { status: number; body: object };
	},
): ControlledPrompt {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const createdSession = descriptor("session-1");
	const createBodies: Protocol.CreateSessionRequest[] = [];
	const listCwds: Array<string | null> = [];
	const paths: string[] = [];
	const promptBodies: Array<{ text: string }> = [];
	const promptSessionIds: string[] = [];
	const promptStarted = Promise.withResolvers<void>();
	const activeSessionId = Promise.withResolvers<string>();
	const streamController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const stderr: string[] = [];
	const stdout: string[] = [];
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController.resolve(controller);
		},
	});

	process.argv = [process.execPath, "ker", ...options.args];
	process.exitCode = undefined;
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	});
	globalThis.fetch = async (input, init): Promise<Response> => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		paths.push(`${method} ${url.pathname}`);
		if (url.pathname === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION }, 200);
		if (url.pathname === "/sessions" && method === "POST") {
			createBodies.push(JSON.parse(String(init?.body)) as Protocol.CreateSessionRequest);
			if (options.createStatus !== undefined && options.createStatus !== 201) {
				return jsonResponse({}, options.createStatus);
			}
			return jsonResponse(createdSession, 201);
		}
		if (url.pathname === "/sessions") {
			listCwds.push(url.searchParams.get("cwd"));
			return jsonResponse({ sessions: options.sessions ?? [], unreadable: [] }, 200);
		}
		const snapshotMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
		if (snapshotMatch) {
			const sessionId = decodeURIComponent(snapshotMatch[1]);
			const session =
				options.sessions?.find((candidate) => candidate.id === sessionId) ??
				(sessionId === createdSession.id ? createdSession : descriptor(sessionId));
			return jsonResponse({ ...snapshot(session), compactionFailure: options.compactionFailure }, 200);
		}
		const eventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
		if (eventsMatch) {
			activeSessionId.resolve(decodeURIComponent(eventsMatch[1]));
			return new Response(body, { status: 200 });
		}
		const promptsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompts$/);
		if (promptsMatch) {
			const sessionId = decodeURIComponent(promptsMatch[1]);
			promptSessionIds.push(sessionId);
			promptBodies.push(JSON.parse(String(init?.body)) as { text: string });
			promptStarted.resolve();
			if (options.promptRejection) {
				return jsonResponse(options.promptRejection.body, options.promptRejection.status);
			}
			return jsonResponse(admission(sessionId), 202);
		}
		throw new Error(`Unexpected request to ${url.pathname}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});

	return {
		createBodies,
		listCwds,
		paths,
		promptBodies,
		promptSessionIds,
		promptStarted,
		stderr,
		stdout,
		complete() {
			void Promise.all([activeSessionId.promise, streamController.promise]).then(([sessionId, controller]) => {
				const events: Protocol.Event[] = [
					{
						actor: "agent",
						modelRole: "assistant",
						sessionId,
						turnId: "turn-1",
						type: "message_delta",
						messageId: "assistant-1",
						offset: 0,
						text: "answer",
					},
					{
						actor: "agent",
						modelRole: "assistant",
						sessionId,
						turnId: "turn-1",
						type: "assistant_message_completed",
						messageId: "assistant-1",
						reason: "completed",
					},
					{
						actor: "process",
						sessionId,
						turnId: "turn-1",
						type: "turn_terminal",
						reason: "completed",
					},
					{ actor: "process", sessionId, turnId: "turn-1", type: "end" },
				];
				for (const [index, event] of events.entries()) {
					const envelope: Protocol.EventEnvelope = { epoch: "epoch-1", sequence: index + 1, event };
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
				}
				controller.close();
			});
		},
	};
}

function descriptor(id: Protocol.SessionId, updatedAt = "2026-01-01T00:00:00.000Z"): Protocol.SessionDescriptor {
	return {
		id,
		cwd: process.cwd(),
		projectRoot: process.cwd(),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt,
	};
}

function snapshot(session: Protocol.SessionDescriptor): Protocol.SessionSnapshot {
	return {
		session,
		usage: {
			contextTokens: 0,
			cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		entries: [],
		messages: [],
		turns: [],
		queue: { revision: 0, waiting: [] },
		cursor: { epoch: "epoch-1", sequence: 0 },
	};
}

function admission(sessionId: Protocol.SessionId): Protocol.PromptAdmission {
	return {
		status: "running",
		sessionId,
		turnId: "turn-1",
		messageId: "message-1",
		queueItemId: "queue-1",
		queue: { revision: 1, waiting: [] },
	};
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
