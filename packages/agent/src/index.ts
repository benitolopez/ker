import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool } from "@ker-ai/engine";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

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

export const tools: Tool[] = [read];

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
