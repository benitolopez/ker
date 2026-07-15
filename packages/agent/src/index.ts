import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Tool } from "@ker-ai/engine";
import * as Bash from "./bash-output.ts";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "./output-limits.ts";

export { truncateTail } from "./bash-output.ts";

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
		`line number. Output is capped at ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024}KB, whichever ` +
		"comes first; use offset and limit to page through longer files.",
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
		return formatRead(raw, offset, limit, path);
	},
};

const write: Tool = {
	name: "write",
	description:
		"Write a UTF-8 text file to disk. Creates the file if it doesn't exist, or overwrites it in full " +
		"if it does; parent directories are created as needed. Content is written verbatim, so pass the " +
		"complete file. Use write to create a new file or replace one in full; to change part of an " +
		"existing file, use edit instead.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file, relative to the working directory or absolute." },
			content: { type: "string", description: "The full file contents to write, verbatim." },
		},
		required: ["path", "content"],
		additionalProperties: false,
	},
	async execute(args: unknown): Promise<string> {
		const { path, content } = args as { path?: unknown; content?: unknown };
		if (typeof path !== "string" || path.trim() === "") throw new Error("write: 'path' must be a non-empty string");
		if (typeof content !== "string") throw new Error("write: 'content' must be a string");
		const resolved = resolve(path);
		const existed = existsSync(resolved);
		await mkdir(dirname(resolved), { recursive: true });
		await writeFile(resolved, content, "utf8");
		return `${existed ? "Wrote" : "Created"} ${path} (${Buffer.byteLength(content, "utf8")} bytes)`;
	},
};

const edit: Tool = {
	name: "edit",
	description:
		"Edit a UTF-8 text file by replacing an exact substring. old_string must match the file verbatim — " +
		"including whitespace and indentation — and must be unique; keep it as small as possible while still " +
		"unique. If it is missing or appears more than once the edit is rejected, so add surrounding context " +
		"to make it unique, or pass replaceAll to change every occurrence. When copying text the read tool " +
		"showed you, match only the content after its `N: ` line-number prefix, never the number itself. Use " +
		"edit to change part of an existing file; use write to create a new file or replace one in full.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file, relative to the working directory or absolute." },
			old_string: {
				type: "string",
				description: "The exact text to replace. Must match the file verbatim and be unique unless replaceAll is set.",
			},
			new_string: { type: "string", description: "The text to replace it with." },
			replaceAll: {
				type: "boolean",
				description: "Replace every occurrence of old_string instead of requiring a unique match. Defaults to false.",
			},
		},
		required: ["path", "old_string", "new_string"],
		additionalProperties: false,
	},
	async execute(args: unknown): Promise<string> {
		const { path, old_string, new_string, replaceAll } = args as {
			path?: unknown;
			old_string?: unknown;
			new_string?: unknown;
			replaceAll?: unknown;
		};
		if (typeof path !== "string" || path.trim() === "") throw new Error("edit: 'path' must be a non-empty string");
		if (typeof old_string !== "string") throw new Error("edit: 'old_string' must be a string");
		if (typeof new_string !== "string") throw new Error("edit: 'new_string' must be a string");
		if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
			throw new Error("edit: 'replaceAll' must be a boolean");
		}
		if (old_string === new_string) throw new Error("old_string and new_string are identical — no change to make.");
		const resolved = resolve(path);
		const original = await readFile(resolved, "utf8");
		const { content, count } = applyEdit(original, old_string, new_string, replaceAll ?? false);
		await writeFile(resolved, content, "utf8");
		return `Edited ${path} (${count} ${count === 1 ? "occurrence" : "occurrences"})`;
	},
};

const bash: Tool = {
	name: "bash",
	description:
		"Run a bash command in the working directory and return its combined stdout and stderr. Output is " +
		`capped at the last ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024}KB, whichever comes first; ` +
		"when truncated, the full output is written to a private temp file whose path is included so you can " +
		"read it. A command is killed with " +
		"its child processes if that file reaches 1 GiB. Provide an optional timeout in seconds (default 120); " +
		"a command that runs longer is also killed with its child processes. Use this for shell work and for " +
		"discovery — ls, grep, find, git, running builds and tests.",
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

export const tools: Tool[] = [read, write, edit, bash];

// Number every line while keeping the complete result within both output caps. An oversized first line
// is cut at a UTF-8 boundary and carries a byte-exact bash command for reading the remainder.
export function formatRead(raw: string, offset: number | undefined, limit: number | undefined, path: string): string {
	const lines = raw.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const total = lines.length;
	if (total === 0) return "(empty file)";
	const start = (offset ?? 1) - 1;
	if (start >= total) throw new Error(`read: offset ${offset} is beyond end of file (${total} lines)`);
	const userEnd = limit !== undefined ? Math.min(start + limit, total) : total;

	const shown: string[] = [];
	const sizes: number[] = [];
	let bytes = 0;
	let end = start;
	for (; end < userEnd; end++) {
		const line = `${end + 1}: ${lines[end]}`;
		const size = Buffer.byteLength(line, "utf8") + (shown.length > 0 ? 1 : 0);
		if (shown.length >= MAX_OUTPUT_LINES || bytes + size > MAX_OUTPUT_BYTES) break;
		shown.push(line);
		sizes.push(size);
		bytes += size;
	}

	const body = shown.join("\n");
	if (end >= total) return body;

	while (shown.length > 0) {
		const note = `\n\n[showing lines ${start + 1}-${end} of ${total}; use offset=${end + 1} to continue]`;
		if (bytes + Buffer.byteLength(note, "utf8") <= MAX_OUTPUT_BYTES) return `${shown.join("\n")}${note}`;
		shown.pop();
		bytes -= sizes.pop() ?? 0;
		end--;
	}

	return formatOversizedReadLine(lines, start, path);
}

// Reserve the notice before cutting the line so the complete result stays within the byte cap.
function formatOversizedReadLine(lines: string[], start: number, path: string): string {
	const prefix = `${start + 1}: `;
	const lineStartBytes = start === 0 ? 0 : Buffer.byteLength(lines.slice(0, start).join("\n"), "utf8") + 1;
	const quotedPath = `'${path.replaceAll("'", "'\\''")}'`;
	const largestNextByte = lineStartBytes + MAX_OUTPUT_BYTES + 1;
	const reservedNote =
		`\n\n[line ${start + 1} truncated to keep the read result within ${MAX_OUTPUT_BYTES / 1024}KB; ` +
		`use bash to inspect the remainder: tail -c +${largestNextByte} -- ${quotedPath} | head -c ${MAX_OUTPUT_BYTES}]`;
	const lineBytes = Buffer.from(lines[start], "utf8");
	const available = Math.max(
		0,
		MAX_OUTPUT_BYTES - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(reservedNote, "utf8"),
	);
	let sliceEnd = Math.min(available, lineBytes.length);
	while (sliceEnd > 0 && sliceEnd < lineBytes.length && (lineBytes[sliceEnd] & 0xc0) === 0x80) sliceEnd--;
	const nextByte = lineStartBytes + sliceEnd + 1;
	const note =
		`\n\n[line ${start + 1} truncated to keep the read result within ${MAX_OUTPUT_BYTES / 1024}KB; ` +
		`use bash to inspect the remainder: tail -c +${nextByte} -- ${quotedPath} | head -c ${MAX_OUTPUT_BYTES}]`;
	return `${prefix}${lineBytes.subarray(0, sliceEnd).toString("utf8")}${note}`;
}

// Replace an exact substring in a file's content, preserving the file's own line endings and BOM. old_string
// is matched against the native bytes (the model's LF input is first converted to the file's ending), so
// unchanged text keeps its exact bytes; the match must be unique unless replaceAll is set. Throws a
// model-readable message when old_string is empty, identical to new_string, missing, or ambiguous.
export function applyEdit(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): { content: string; count: number } {
	if (oldString === "") {
		throw new Error("old_string must not be empty — use write to create a file or replace it wholesale.");
	}
	const { bom, text } = stripBom(content);
	const ending = detectLineEnding(text);
	const nativeOld = restoreLineEndings(normalizeToLF(oldString), ending);
	const nativeNew = restoreLineEndings(normalizeToLF(newString), ending);
	if (nativeOld === nativeNew) throw new Error("old_string and new_string are identical — no change to make.");

	const count = text.split(nativeOld).length - 1;
	if (count === 0) {
		throw new Error(
			"Could not find old_string in the file. It must match exactly, including whitespace, indentation, and line endings.",
		);
	}
	if (count > 1 && !replaceAll) {
		throw new Error(
			`Found ${count} occurrences of old_string. Add surrounding context to make it unique, or pass replaceAll to change every one.`,
		);
	}

	if (replaceAll) return { content: bom + text.split(nativeOld).join(nativeNew), count };
	const i = text.indexOf(nativeOld);
	return { content: `${bom}${text.slice(0, i)}${nativeNew}${text.slice(i + nativeOld.length)}`, count };
}

// The file's first newline decides its ending: CRLF only when the first "\n" is preceded by "\r".
function detectLineEnding(text: string): "\r\n" | "\n" {
	const crlf = text.indexOf("\r\n");
	const lf = text.indexOf("\n");
	if (lf === -1 || crlf === -1) return "\n";
	return crlf < lf ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

// Run a bash command in the working directory, killing it and its process group if it outruns the
// timeout. Stdout and stderr interleave in arrival order; a bounded tail stays in memory while the full
// stream moves to a private file once it exceeds the preview. A non-zero exit comes back as data, while
// signal termination, timeout, spill failure, output-limit, and spawn errors throw so the model sees a
// failed tool call.
async function runBash(command: string, timeoutSecs: number): Promise<string> {
	const child = spawn(resolveShell(), ["-c", command], {
		cwd: process.cwd(),
		env: process.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const output = new Bash.OutputAccumulator({
		pause: () => {
			child.stdout?.pause();
			child.stderr?.pause();
		},
		resume: () => {
			child.stdout?.resume();
			child.stderr?.resume();
		},
		stop: () => {
			if (child.pid !== undefined) killTree(child.pid);
		},
	});
	child.stdout?.on("data", (data: Buffer) => {
		output.append(data);
	});
	child.stderr?.on("data", (data: Buffer) => {
		output.append(data);
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid !== undefined) killTree(child.pid);
	}, timeoutSecs * 1000);

	const exit = await waitForExit(child, () => output.isBackpressured).then(
		(status) => ({ status }) as const,
		(error: unknown) => ({ error }) as const,
	);
	clearTimeout(timer);
	const snapshot = await output.finish();
	if ("error" in exit) throw exit.error;

	const locationLabel = output.failure ? "partial output" : output.limitReached ? "captured output" : "full output";
	const location = snapshot.path ? `${locationLabel}: ${snapshot.path}` : "full output unavailable";
	const formatted = snapshot.truncated
		? appendNote(
				snapshot.text,
				`output truncated: showing last ${snapshot.shown} of ${snapshot.total} lines; ${location}`,
			)
		: snapshot.text;
	if (output.failure) {
		throw new Error(appendNote(formatted, `failed to save bash output: ${output.failure.message}; command terminated`));
	}
	if (output.limitReached) {
		throw new Error(
			appendNote(
				formatted,
				`bash output reached the ${Bash.MAX_SPILL_BYTES / 1024 ** 3} GiB safety limit; command terminated`,
			),
		);
	}
	if (timedOut) throw new Error(appendNote(formatted, `timed out after ${timeoutSecs}s`));
	if (exit.status.signal !== null) {
		throw new Error(appendNote(formatted, `terminated by ${exit.status.signal}`));
	}
	if (exit.status.code !== 0 && exit.status.code !== null) {
		return appendNote(formatted, `exited with code ${exit.status.code}`);
	}
	return formatted || "(no output)";
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

// Resolve when the child exits and its pipes fall idle. A detached grandchild can keep stdout open, so
// waiting for "close" would hang; data rearms a short post-exit timer, and spill backpressure postpones
// that timer until paused pipes can resume.
function waitForExit(
	child: ChildProcess,
	outputBackpressured: () => boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolveExit, rejectExit) => {
		let exited = false;
		let settled = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let idle: NodeJS.Timeout | undefined;

		const finish = () => {
			if (settled) return;
			settled = true;
			if (idle) clearTimeout(idle);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolveExit({ code: exitCode, signal: exitSignal });
		};
		const armIdle = () => {
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => {
				if (outputBackpressured()) {
					armIdle();
					return;
				}
				finish();
			}, IDLE_GRACE_MS);
		};

		child.stdout?.on("data", () => {
			if (exited) armIdle();
		});
		child.stderr?.on("data", () => {
			if (exited) armIdle();
		});
		child.once("exit", (code, signal) => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			armIdle();
		});
		child.once("close", (code, signal) => {
			exitCode = code ?? exitCode;
			exitSignal = signal ?? exitSignal;
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

// Append a bracketed status note to command output, or return it alone when the command printed nothing.
function appendNote(output: string, note: string): string {
	return output ? `${output}\n\n[${note}]` : `[${note}]`;
}
