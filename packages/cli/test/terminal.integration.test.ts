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

test("prompt SIGINT cancels for an attached client without detaching it", { timeout: 20_000 }, async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "ker-cli-terminal-"));
	const providerStarted = Promise.withResolvers<void>();
	const firstDelta = Promise.withResolvers<void>();
	const secondDelta = Promise.withResolvers<void>();
	const harnessFactory: NonNullable<DaemonOptions["harnessFactory"]> = (initial) =>
		createHarness(
			{
				model: "test-model",
				getAuth: async () => ({ kind: "apikey", key: "test" }),
				tools: [],
				systemPrompt: "Test system prompt",
			},
			{
				stream: async function* (_model, _messages, _auth, options) {
					providerStarted.resolve();
					if (!(await waitForRelease(firstDelta.promise, options?.signal))) {
						yield { type: "aborted" };
						return;
					}
					yield { type: "delta", text: "one" };
					if (!(await waitForRelease(secondDelta.promise, options?.signal))) {
						yield { type: "aborted" };
						return;
					}
					yield { type: "delta", text: "two" };
					await waitForAbort(options?.signal);
					yield { type: "aborted" };
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

	const session = await createSession(daemonUrl);
	const prompt = startCli(["--session", session.id, "hello"], daemonUrl);
	children.add(prompt.child);
	await waitForProvider(providerStarted.promise, prompt);

	const attach = startCli(["attach", session.id], daemonUrl);
	children.add(attach.child);
	firstDelta.resolve();
	await waitForOutput(attach, "one");
	secondDelta.resolve();
	await waitForOutput(attach, "onetwo");

	assert.equal(prompt.child.kill("SIGINT"), true);
	const promptExit = await waitForClose(prompt);
	assert.deepEqual(promptExit, { code: 130, signal: null });
	assert.match(prompt.stderr.join(""), /ker: cancelling \(turn .+\)/);
	await waitForOutput(attach, "ker: aborted", "stderr");
	assert.match(attach.stderr.join(""), /ker: cancelling \(turn .+\)\nker: aborted \(turn .+\)/);
	assert.equal(attach.child.exitCode, null);
	assert.equal(attach.child.signalCode, null);

	assert.equal(attach.child.kill("SIGINT"), true);
	const attachExit = await waitForClose(attach);
	assert.deepEqual(attachExit, { code: 0, signal: null });
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

function createSession(daemonUrl: string): Promise<Protocol.SessionDescriptor> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${daemonUrl}/sessions`,
			{ method: "POST", headers: { host: `127.0.0.1:${DEFAULT_PORT}` } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.once("error", reject);
				res.once("end", () => {
					assert.equal(res.statusCode, 201);
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Protocol.SessionDescriptor);
				});
			},
		);
		req.once("error", reject);
		req.end();
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

async function waitForRelease(release: Promise<void>, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return false;
	return Promise.race([release.then(() => true), waitForAbort(signal).then(() => false)]);
}
