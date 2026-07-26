import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { run } from "../src/index.ts";

test("new sends the caller cwd in its JSON request", async (t) => {
	const session = descriptor("session-1");
	const controlled = controlCli(t, ["--json", "new"], (url) => {
		if (url.pathname === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION });
		if (url.pathname === "/sessions") return jsonResponse(session, 201);
		throw new Error(`Unexpected request to ${url}`);
	});

	await run();

	assert.equal(controlled.calls.length, 2);
	const creation = controlled.calls[1];
	assert.equal(creation.url.pathname, "/sessions");
	assert.equal(creation.init?.method, "POST");
	assert.deepEqual(creation.init?.headers, { "content-type": "application/json" });
	assert.deepEqual(JSON.parse(String(creation.init?.body)) as Protocol.CreateSessionRequest, {
		cwd: process.cwd(),
	});
	assert.deepEqual(JSON.parse(controlled.stdout.join("")) as Protocol.SessionDescriptor, session);
});

test("sessions filters by cwd unless --all is present", async (t) => {
	await t.test("cwd", async (t) => {
		const body: Protocol.ListSessionsResponse = { sessions: [descriptor("session-1")], unreadable: [] };
		const controlled = controlCli(t, ["--json", "sessions"], (url) => {
			if (url.pathname === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION });
			if (url.pathname === "/sessions") return jsonResponse(body);
			throw new Error(`Unexpected request to ${url}`);
		});

		await run();

		const listing = controlled.calls[1].url;
		assert.deepEqual([...listing.searchParams.entries()], [["cwd", process.cwd()]]);
		assert.deepEqual(JSON.parse(controlled.stdout.join("")) as Protocol.ListSessionsResponse, body);
	});

	await t.test("all", async (t) => {
		const body: Protocol.ListSessionsResponse = { sessions: [], unreadable: [] };
		const controlled = controlCli(t, ["sessions", "--all"], (url) => {
			if (url.pathname === "/health") return jsonResponse({ protocol: PROTOCOL_VERSION });
			if (url.pathname === "/sessions") return jsonResponse(body);
			throw new Error(`Unexpected request to ${url}`);
		});

		await run();

		assert.deepEqual([...controlled.calls[1].url.searchParams.entries()], [["scope", "all"]]);
	});
});

test("--all is rejected on unrelated commands", async (t) => {
	const controlled = controlCli(t, ["new", "--all"], () => {
		throw new Error("Invalid commands must not send requests");
	});

	await run();

	assert.deepEqual(controlled.calls, []);
	assert.equal(process.exitCode, 1);
	assert.match(controlled.stderr.join(""), /sessions \[--all\]/);
});

test("a protocol mismatch stops before the session request", async (t) => {
	const controlled = controlCli(t, ["new"], (url) => {
		if (url.pathname === "/health") return jsonResponse({ protocol: "mismatch" });
		throw new Error(`Unexpected request to ${url}`);
	});

	await run();

	assert.equal(controlled.calls.length, 1);
	assert.equal(process.exitCode, 1);
	assert.match(
		controlled.stderr.join(""),
		new RegExp(`daemon speaks protocol mismatch, this client needs ${PROTOCOL_VERSION}`),
	);
});

interface ControlledCli {
	calls: Array<{ url: URL; init?: RequestInit }>;
	stderr: string[];
	stdout: string[];
}

function controlCli(
	t: TestContext,
	args: string[],
	respond: (url: URL, init?: RequestInit) => Response,
): ControlledCli {
	const originalFetch = globalThis.fetch;
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const calls: ControlledCli["calls"] = [];
	const stderr: string[] = [];
	const stdout: string[] = [];

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
	globalThis.fetch = async (input, init): Promise<Response> => {
		const url = new URL(String(input));
		calls.push({ url, init });
		return respond(url, init);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	});
	return { calls, stderr, stdout };
}

function descriptor(id: string): Protocol.SessionDescriptor {
	return {
		id,
		cwd: process.cwd(),
		projectRoot: process.cwd(),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function jsonResponse(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
