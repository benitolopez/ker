import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT } from "@ker-ai/protocol";
import { createDaemon, type DaemonOptions } from "../../daemon/src/index.ts";
import { createHarness } from "../../engine/src/index.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_PATH = join(PROJECT_ROOT, "packages/cli/src/cli.ts");
const REDIRECT_PATH = join(PROJECT_ROOT, "packages/cli/test/fixtures/redirect-fetch.ts");

test("session FIFO runs beside another session and survives exact cancellation", { timeout: 20_000 }, async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-cli-terminal-"));
	const providerStarted = Promise.withResolvers<void>();
	const harnessFactory: NonNullable<DaemonOptions["harnessFactory"]> = (initial) =>
		createHarness(
			{
				model: "test-model",
				getAuth: async () => ({ kind: "apikey", key: "test" }),
				tools: [],
				systemPrompt: "Test system prompt",
			},
			{
				stream: async function* (_model, messages, _auth, options) {
					const text = messages.findLast((message) => message.role === "user")?.content;
					if (text === "hold session A") {
						providerStarted.resolve();
						yield { type: "delta", text: "A running" };
						await waitForAbort(options?.signal);
						yield { type: "aborted" };
						return;
					}
					if (text === "reply with second") {
						yield { type: "delta", text: "reply with second" };
						yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
						return;
					}
					if (text === "reply with session B") {
						yield { type: "delta", text: "reply with session B" };
						yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
						return;
					}
					yield { type: "error", message: `Unexpected test prompt: ${text}`, retryable: false };
				},
			},
			initial,
		);
	const server = createDaemon({ cwd: PROJECT_ROOT, projectRoot: PROJECT_ROOT, sessionDir, harnessFactory });
	const children = new Set<ChildProcess>();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	const daemonUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
	t.after(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		await server.shutdown();
		server.closeAllConnections();
		if (server.listening) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		await rm(sessionDir, { recursive: true, force: true });
	});

	const sessionA = await createSession(daemonUrl);
	const sessionB = await createSession(daemonUrl);
	assert.equal((await localRequest(daemonUrl, "/queue")).status, 404);
	const obsoletePrompt = await localRequest(daemonUrl, `/sessions/${sessionA.id}/prompts`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "hello", placement: "end" }),
	});
	assert.equal(obsoletePrompt.status, 400);
	assert.deepEqual(JSON.parse(obsoletePrompt.body) as object, { code: "invalid_prompt" });

	const firstA = startCli(["--session", sessionA.id, "hold session A"], daemonUrl);
	children.add(firstA.child);
	await waitForProvider(providerStarted.promise, firstA);

	const monitor = startCli(["monitor", sessionA.id], daemonUrl);
	children.add(monitor.child);
	await waitForOutput(monitor, "A running");
	await waitForOutput(monitor, "> hold session A", "stderr");

	const secondA = startCli(["--session", sessionA.id, "reply with second"], daemonUrl);
	children.add(secondA.child);
	await waitForOutput(secondA, "ker: waiting", "stderr");
	await waitForOutput(monitor, "> reply with second", "stderr");
	assert.equal(secondA.child.exitCode, null);

	const promptB = startCli(["--session", sessionB.id, "reply with session B"], daemonUrl);
	children.add(promptB.child);
	assert.deepEqual(await waitForClose(promptB), { code: 0, signal: null });
	assert.equal(promptB.stdout.join(""), "reply with session B\n");
	assert.doesNotMatch(monitor.stdout.join(""), /session B/);
	assert.equal(firstA.child.exitCode, null);

	const cancel = startCli(["cancel", sessionA.id], daemonUrl);
	children.add(cancel.child);
	const cancelExit = await waitForClose(cancel);
	assert.deepEqual(cancelExit, { code: 0, signal: null });
	assert.match(cancel.stderr.join(""), /ker: cancelling \(turn .+\)/);
	const firstAExit = await waitForClose(firstA);
	assert.deepEqual(firstAExit, { code: 130, signal: null });
	assert.match(firstA.stderr.join(""), /ker: cancelling \(turn .+\)/);
	await waitForOutput(monitor, "ker: aborted", "stderr");
	assert.match(monitor.stderr.join(""), /ker: cancelling \(turn .+\)\nker: aborted \(turn .+\)/);
	assert.deepEqual(await waitForClose(secondA), { code: 0, signal: null });
	assert.equal(secondA.stdout.join(""), "reply with second\n");
	await waitForOutput(monitor, "reply with second");
	await waitForOutput(monitor, "ker: waiting for turns", "stderr");
	assert.equal(monitor.stdout.join(""), "A running\nreply with second\n");
	assert.doesNotMatch(monitor.stdout.join(""), /hold session A/);
	assert.equal(monitor.child.exitCode, null);
	assert.equal(monitor.child.signalCode, null);

	assert.equal(monitor.child.kill("SIGINT"), true);
	const monitorExit = await waitForClose(monitor);
	assert.deepEqual(monitorExit, { code: 0, signal: null });
});

interface RunningCli {
	child: ChildProcess;
	closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	stderr: string[];
	stdout: string[];
}

function startCli(args: string[], daemonUrl: string): RunningCli {
	const child = spawn(process.execPath, ["--import", REDIRECT_PATH, CLI_PATH, ...args], {
		cwd: PROJECT_ROOT,
		env: { ...process.env, KER_TEST_DAEMON_URL: daemonUrl },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stderr: string[] = [];
	const stdout: string[] = [];
	child.stderr?.setEncoding("utf8");
	child.stdout?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
	child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	return { child, closed, stderr, stdout };
}

async function createSession(daemonUrl: string): Promise<Protocol.SessionDescriptor> {
	const response = await localRequest(daemonUrl, "/sessions", { method: "POST" });
	assert.equal(response.status, 201);
	return JSON.parse(response.body) as Protocol.SessionDescriptor;
}

function localRequest(
	daemonUrl: string,
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${daemonUrl}${path}`,
			{ method: init.method, headers: { ...init.headers, host: `127.0.0.1:${DEFAULT_PORT}` } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.once("error", reject);
				res.once("end", () => {
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
				});
			},
		);
		req.once("error", reject);
		req.end(init.body);
	});
}

async function waitForOutput(cli: RunningCli, text: string, stream: "stdout" | "stderr" = "stdout"): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (cli[stream].join("").includes(text)) return;
		if (cli.child.exitCode !== null || cli.child.signalCode !== null) {
			throw new Error(`CLI exited before writing ${JSON.stringify(text)}: ${cli.stderr.join("")}`);
		}
		await sleep(10);
	}
	throw new Error(`CLI did not write ${JSON.stringify(text)}: ${cli.stderr.join("")}`);
}

async function waitForClose(cli: RunningCli): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return Promise.race([
		cli.closed,
		sleep(5_000, undefined, { ref: false }).then(() => {
			throw new Error(`CLI did not exit: ${cli.stderr.join("")}`);
		}),
	]);
}

async function waitForProvider(started: Promise<void>, cli: RunningCli): Promise<void> {
	return Promise.race([
		started,
		cli.closed.then((result) => {
			throw new Error(`CLI exited before starting the provider (${JSON.stringify(result)}): ${cli.stderr.join("")}`);
		}),
		sleep(5_000, undefined, { ref: false }).then(() => {
			throw new Error(`CLI did not start the provider: ${cli.stderr.join("")}`);
		}),
	]);
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}
