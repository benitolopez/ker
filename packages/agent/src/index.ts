import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool } from "@ker-ai/engine";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const DEFAULT_TIMEOUT_SECS = 120;
const KILL_GRACE_MS = 2000;
const IDLE_GRACE_MS = 100;

// The coding agent's system prompt. Kept short on purpose: each tool's own description (sent in the API
// tools array) carries its usage, so this only sets identity, the working directory, and a few habits.
export const systemPrompt = [
	"You are ker, a terminal coding agent working in the user's project.",
	`The working directory is ${process.cwd()}; paths you pass to tools resolve against it.`,
	"Read files before answering questions about them — don't guess at code you haven't seen.",
	"When you cite code, give its path and line number (e.g. packages/engine/src/index.ts:24).",
	"Be concise and direct.",
].join("\n");

const read: Tool = {
	name: "read",
	description:
		"Read a UTF-8 text file from disk. Returns the contents with each line prefixed by its 1-indexed " +
		"line number. Output is capped at 2000 lines or 50KB, whichever comes first; use offset and limit " +
		"to page through longer files.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file, relative to the working directory or absolute." },
			offset: { type: "number", description: "1-indexed line to start reading from. Defaults to the first line." },
			limit: { type: "number", description: "Maximum number of lines to read." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	async execute(args: unknown): Promise<string> {
		const { path, offset, limit } = args as { path?: unknown; offset?: unknown; limit?: unknown };
		if (typeof path !== "string" || path.trim() === "") throw new Error("read: 'path' must be a non-empty string");
		if (offset !== undefined && (typeof offset !== "number" || offset < 1)) {
			throw new Error("read: 'offset' must be a number >= 1");
		}
		if (limit !== undefined && (typeof limit !== "number" || limit < 1)) {
			throw new Error("read: 'limit' must be a number >= 1");
		}
		const raw = await readFile(resolve(path), "utf8");
		return formatRead(raw, offset, limit);
	},
};

const bash: Tool = {
	name: "bash",
	description:
		"Run a bash command in the working directory and return its combined stdout and stderr. Output is " +
		"capped at the last 2000 lines or 50KB, whichever comes first; when truncated, the full output is " +
		"written to a temp file whose path is included so you can read it. Provide an optional timeout in " +
		"seconds (default 120); a command that runs longer is killed along with its child processes. Use this " +
		"for shell work and for discovery — ls, grep, find, git, running builds and tests.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The bash command to run." },
			timeout: { type: "number", description: "Seconds before the command is killed. Defaults to 120." },
		},
		required: ["command"],
		additionalProperties: false,
	},
	async execute(args: unknown): Promise<string> {
		const { command, timeout } = args as { command?: unknown; timeout?: unknown };
		if (typeof command !== "string" || command.trim() === "") {
			throw new Error("bash: 'command' must be a non-empty string");
		}
		if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0)) {
			throw new Error("bash: 'timeout' must be a positive number of seconds");
		}
		return runBash(command, timeout ?? DEFAULT_TIMEOUT_SECS);
	},
};

export const tools: Tool[] = [read, bash];

// Number every line, then keep whole lines until the 2000-line or 50KB cap trips (the first line is always
// kept, even if it alone exceeds the byte cap). When lines remain past what's shown, append a notice with
// the offset to continue from, so the model can page itself.
export function formatRead(raw: string, offset: number | undefined, limit: number | undefined): string {
	const lines = raw.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const total = lines.length;
	if (total === 0) return "(empty file)";
	const start = (offset ?? 1) - 1;
	if (start >= total) throw new Error(`read: offset ${offset} is beyond end of file (${total} lines)`);
	const userEnd = limit !== undefined ? Math.min(start + limit, total) : total;

	const shown: string[] = [];
	let bytes = 0;
	let end = start;
	for (; end < userEnd; end++) {
		const line = `${end + 1}: ${lines[end]}`;
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (shown.length > 0 && (shown.length >= MAX_LINES || bytes + size > MAX_BYTES)) break;
		shown.push(line);
		bytes += size;
	}

	const body = shown.join("\n");
	if (end >= total) return body;
	return `${body}\n\n[showing lines ${start + 1}-${end} of ${total}; use offset=${end + 1} to continue]`;
}

// Run a bash command in the working directory, killing it and its process group if it outruns the
// timeout. stdout and stderr interleave into one buffer in arrival order; the result is tail-truncated
// to the last 2000 lines / 50KB, with the full output spilled to a temp file when cut. A non-zero exit
// comes back as data with the code noted, while a timeout or a shell that won't spawn throws, so the
// model reads those as an error.
async function runBash(command: string, timeoutSecs: number): Promise<string> {
	const child = spawn(resolveShell(), ["-c", command], {
		cwd: process.cwd(),
		env: process.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const chunks: Buffer[] = [];
	child.stdout?.on("data", (data: Buffer) => {
		chunks.push(data);
	});
	child.stderr?.on("data", (data: Buffer) => {
		chunks.push(data);
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid !== undefined) killTree(child.pid);
	}, timeoutSecs * 1000);

	let exitCode: number | null;
	try {
		exitCode = await waitForExit(child);
	} finally {
		clearTimeout(timer);
	}

	const output = await formatBashOutput(Buffer.concat(chunks).toString("utf8"));
	if (timedOut) throw new Error(appendNote(output, `timed out after ${timeoutSecs}s`));
	if (exitCode !== 0 && exitCode !== null) return appendNote(output, `exited with code ${exitCode}`);
	return output || "(no output)";
}

// Prefer bash so bashisms in a command work as written; fall back to sh only where bash is absent.
function resolveShell(): string {
	if (existsSync("/bin/bash")) return "/bin/bash";
	const which = spawnSync("which", ["bash"], { encoding: "utf8" });
	const found = which.status === 0 ? which.stdout.trim().split("\n")[0] : "";
	return found || "sh";
}

// Kill the command's whole process group so grandchildren — a dev server under `npm run dev` — die with
// it. SIGTERM first for a clean shutdown, then SIGKILL after a grace if the group is still alive. The
// negative pid targets the group (the command was spawned detached). This is the one kill path; the
// step-3 abort signal will reuse it.
function killTree(pid: number): void {
	const groupKill = (signal: NodeJS.Signals): boolean => {
		try {
			process.kill(-pid, signal);
			return true;
		} catch {
			return false;
		}
	};
	if (!groupKill("SIGTERM")) return;
	setTimeout(() => groupKill("SIGKILL"), KILL_GRACE_MS).unref();
}

// Resolve when the child exits and its pipes fall idle. A short-lived child can exit while a detached
// grandchild keeps stdout open, so waiting for "close" would hang; instead, once "exit" fires, a short
// idle timer re-armed on every chunk releases us after output stops without truncating a tail that is
// still being written. Mirrors pi's waitForChildProcess.
function waitForExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolveExit, rejectExit) => {
		let exited = false;
		let settled = false;
		let exitCode: number | null = null;
		let idle: NodeJS.Timeout | undefined;

		const finish = () => {
			if (settled) return;
			settled = true;
			if (idle) clearTimeout(idle);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolveExit(exitCode);
		};
		const armIdle = () => {
			if (idle) clearTimeout(idle);
			idle = setTimeout(finish, IDLE_GRACE_MS);
		};

		child.stdout?.on("data", () => {
			if (exited) armIdle();
		});
		child.stderr?.on("data", () => {
			if (exited) armIdle();
		});
		child.once("exit", (code) => {
			exited = true;
			exitCode = code;
			armIdle();
		});
		child.once("close", (code) => {
			exitCode = code ?? exitCode;
			finish();
		});
		child.once("error", (err) => {
			if (settled) return;
			settled = true;
			if (idle) clearTimeout(idle);
			rejectExit(err);
		});
	});
}

// Tail-truncate combined output to the last 2000 lines / 50KB — a command's errors usually sit at the
// end. When cut, write the whole output to a temp file and point at it so the model can page the full
// log with `read`.
async function formatBashOutput(full: string): Promise<string> {
	const tail = truncateTail(full);
	if (!tail.truncated) return tail.text;
	const path = join(tmpdir(), `ker-bash-${randomUUID()}.txt`);
	await writeFile(path, full);
	return `${tail.text}\n\n[output truncated: showing last ${tail.shown} of ${tail.total} lines; full output: ${path}]`;
}

// Keep whole lines from the end until the 2000-line or 50KB cap trips. Only when a single trailing line
// alone exceeds the byte cap is that line sliced back to a UTF-8 boundary, so there is always a tail.
export function truncateTail(content: string): { text: string; truncated: boolean; shown: number; total: number } {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const total = lines.length;
	if (total === 0) return { text: content, truncated: false, shown: 0, total: 0 };

	const kept: string[] = [];
	let bytes = 0;
	for (let i = total - 1; i >= 0; i--) {
		const size = Buffer.byteLength(lines[i], "utf8") + (kept.length > 0 ? 1 : 0);
		if (kept.length >= MAX_LINES || bytes + size > MAX_BYTES) break;
		kept.unshift(lines[i]);
		bytes += size;
	}

	if (kept.length === 0) {
		const buf = Buffer.from(lines[total - 1], "utf8");
		let start = buf.length - MAX_BYTES;
		while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
		return { text: buf.subarray(start).toString("utf8"), truncated: true, shown: 1, total };
	}
	return { text: kept.join("\n"), truncated: kept.length < total, shown: kept.length, total };
}

// Append a bracketed status note to command output, or return it alone when the command printed nothing.
function appendNote(output: string, note: string): string {
	return output ? `${output}\n\n[${note}]` : `[${note}]`;
}
