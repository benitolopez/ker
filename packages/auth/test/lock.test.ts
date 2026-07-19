import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireLock } from "../src/lock.ts";

const fixture = join(import.meta.dirname, "fixtures", "hold-lock.ts");

interface Holder {
	child: ChildProcess;
	held: Promise<void>;
	exited: Promise<number | null>;
}

// Spawn a separate process that takes the lock via the fixture; `held` resolves once it holds it.
function spawnHolder(path: string, acquireMs: number, holdMs: number, mode?: string): Holder {
	const args = [fixture, path, String(acquireMs), String(holdMs), ...(mode ? [mode] : [])];
	const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
	const held = new Promise<void>((resolve) => {
		child.stdout.on("data", (chunk: Buffer) => {
			if (String(chunk).includes("held")) resolve();
		});
	});
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	return { child, held, exited };
}

let dir: string;
let lockPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ker-lock-"));
	lockPath = join(dir, "auth.json.lock");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("a second process waits until the holder releases", async () => {
	const lock = await acquireLock(lockPath, 1000);
	const contender = spawnHolder(lockPath, 10_000, 0);
	const before = await Promise.race([contender.held.then(() => "held"), sleep(500).then(() => "waiting")]);
	assert.equal(before, "waiting");
	lock.release();
	await contender.held;
	assert.equal(await contender.exited, 0);
});

test("a crashed holder releases the lock", async () => {
	const crasher = spawnHolder(lockPath, 10_000, 60_000, "no-release");
	await crasher.held;
	crasher.child.kill("SIGKILL");
	await crasher.exited;
	const lock = await acquireLock(lockPath, 2000);
	lock.release();
});

test("acquisition times out while another process holds the lock", async () => {
	const holder = spawnHolder(lockPath, 1000, 2000);
	await holder.held;
	await assert.rejects(acquireLock(lockPath, 300), /Timed out/);
	await holder.exited;
});

test("an abort stops lock waiting and closes the contender", async () => {
	const holder = await acquireLock(lockPath, 1000);
	const controller = new AbortController();
	const contender = acquireLock(lockPath, 10_000, controller.signal);
	await sleep(100);
	controller.abort();
	await assert.rejects(contender, (error: unknown) => error instanceof Error && error.name === "AbortError");
	holder.release();
	const next = await acquireLock(lockPath, 1000);
	next.release();
});
