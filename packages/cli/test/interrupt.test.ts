import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("an accepted prompt runs without sending an abort", async (t) => {
	const controlled = controlPrompt(t, true);
	const running = run();
	await controlled.promptStarted.promise;

	controlled.promptResponse.resolve(jsonResponse(submitted(false), 202));
	await controlled.complete([end()]);
	await running;

	assert.deepEqual(controlled.abortBodies, []);
	assert.equal(process.exitCode, undefined);
});

test("SIGINT racing prompt acceptance aborts the exact returned turn", async (t) => {
	const controlled = controlPrompt(t, true);
	const running = run();
	await controlled.promptStarted.promise;
	const interrupt = findNewSignalListener(controlled.signalListeners);

	interrupt("SIGINT");
	controlled.promptResponse.resolve(jsonResponse(submitted(false), 202));
	await running;

	assert.deepEqual(controlled.abortBodies, [{ sessionId: "session-1", turnId: "turn-1" }]);
	assert.equal(process.exitCode, 130);
	assert.match(controlled.stderr.join(""), /ker: aborted/);
});

test("a second SIGINT exits immediately", async (t) => {
	const controlled = controlPrompt(t, true);
	const exitCodes: Array<number | string | null | undefined> = [];
	t.mock.method(process, "exit", (code: number | string | null | undefined) => {
		exitCodes.push(code);
		return undefined as never;
	});
	const running = run();
	await controlled.promptStarted.promise;
	const interrupt = findNewSignalListener(controlled.signalListeners);

	interrupt("SIGINT");
	interrupt("SIGINT");
	controlled.promptResponse.resolve(jsonResponse(submitted(false), 202));
	await running;

	assert.deepEqual(exitCodes, [130]);
});

test("a natural end racing a late abort remains successful", async (t) => {
	const controlled = controlPrompt(t, false);
	const running = run();
	await controlled.promptStarted.promise;
	const interrupt = findNewSignalListener(controlled.signalListeners);

	interrupt("SIGINT");
	controlled.promptResponse.resolve(jsonResponse(submitted(false), 202));
	await running;

	assert.deepEqual(controlled.abortBodies, [{ sessionId: "session-1", turnId: "turn-1" }]);
	assert.equal(process.exitCode, undefined);
});

test("a queued sender acknowledges and never aborts the shared turn", async (t) => {
	const controlled = controlPrompt(t, true);
	const running = run();
	await controlled.promptStarted.promise;
	const interrupt = findNewSignalListener(controlled.signalListeners);

	interrupt("SIGINT");
	controlled.promptResponse.resolve(jsonResponse(submitted(true), 202));
	await running;

	assert.deepEqual(controlled.abortBodies, []);
	assert.equal(controlled.stderr.join(""), "Queued message for the active turn.\n");
	assert.equal(process.exitCode, undefined);
});

test("--json prints only the returned submission for a queued sender", async (t) => {
	const controlled = controlPrompt(t, true, true);
	const running = run();
	await controlled.promptStarted.promise;

	controlled.promptResponse.resolve(jsonResponse(submitted(true), 202));
	await running;

	assert.equal(controlled.stdout.join(""), `${JSON.stringify(submitted(true))}\n`);
	assert.deepEqual(controlled.abortBodies, []);
});

test("a turn starter ignores events belonging to another turn", async (t) => {
	const controlled = controlPrompt(t, true);
	const running = run();
	await controlled.promptStarted.promise;

	controlled.promptResponse.resolve(jsonResponse(submitted(false), 202));
	await controlled.complete([
		{
			actor: "process",
			sessionId: "session-1",
			turnId: "other-turn",
			type: "error",
			message: "other failure",
		},
		{
			actor: "process",
			sessionId: "session-1",
			turnId: "other-turn",
			type: "end",
		},
		{
			actor: "agent",
			modelRole: "assistant",
			sessionId: "session-1",
			turnId: "turn-1",
			type: "message_delta",
			text: "answer",
		},
		end(),
	]);
	await running;

	assert.equal(controlled.stdout.join(""), "answer\n");
	assert.equal(controlled.stderr.join(""), "");
	assert.equal(process.exitCode, undefined);
});

interface ControlledPrompt {
	promptStarted: PromiseWithResolvers<void>;
	promptResponse: PromiseWithResolvers<Response>;
	abortBodies: Array<{ sessionId: string; turnId: string }>;
	signalListeners: Set<(signal: NodeJS.Signals) => void>;
	stderr: string[];
	stdout: string[];
	complete: (events: object[]) => Promise<void>;
}

function controlPrompt(t: TestContext, aborts: boolean, json = false): ControlledPrompt {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const promptStarted = Promise.withResolvers<void>();
	const promptResponse = Promise.withResolvers<Response>();
	const streamController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const abortBodies: Array<{ sessionId: string; turnId: string }> = [];
	const signalListeners = new Set(process.listeners("SIGINT"));
	const stderr: string[] = [];
	const stdout: string[] = [];
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController.resolve(controller);
		},
	});

	process.argv = json ? [process.execPath, "ker", "--json", "hello"] : [process.execPath, "ker", "hello"];
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
		const path = new URL(String(input)).pathname;
		if (path === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION, sessionId: "session-1" }, 200);
		if (path === "/event") return new Response(body, { status: 200 });
		if (path === "/prompt") {
			promptStarted.resolve();
			return promptResponse.promise;
		}
		if (path === "/turn/abort") {
			abortBodies.push(JSON.parse(String(init?.body)) as { sessionId: string; turnId: string });
			const controller = await streamController.promise;
			const events = aborts
				? [
						{
							actor: "process",
							sessionId: "session-1",
							turnId: "turn-1",
							type: "aborted",
						},
						end(),
					]
				: [end()];
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
			return new Response(null, { status: aborts ? 204 : 409 });
		}
		throw new Error(`Unexpected request to ${path}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});

	const complete = async (events: object[]) => {
		const controller = await streamController.promise;
		for (const event of events) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
		}
		controller.close();
	};

	return { promptStarted, promptResponse, abortBodies, signalListeners, stderr, stdout, complete };
}

function findNewSignalListener(before: Set<(signal: NodeJS.Signals) => void>): (signal: NodeJS.Signals) => void {
	const listener = process.listeners("SIGINT").find((candidate) => !before.has(candidate));
	assert(listener);
	return listener;
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function submitted(queued: boolean): object {
	return {
		actor: "human",
		sessionId: "session-1",
		turnId: "turn-1",
		type: "message_submitted",
		messageId: "message-1",
		text: "hello",
		queued,
	};
}

function end(): object {
	return {
		actor: "process",
		sessionId: "session-1",
		turnId: "turn-1",
		type: "end",
	};
}
