import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { appendFile, mkdir, open, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as Protocol from "@ker-ai/protocol";

export const STORE_VERSION = 6 as const;
export const SESSION_FILE = "session.jsonl";
const HEADER_SCAN_BYTES = 8_192;
const TAIL_SCAN_BYTES = 8_192;

interface RecordBase {
	version: typeof STORE_VERSION;
	recordId: string;
	previousRecordId: string | null;
	at: string;
	type: string;
}

export interface SessionRecord extends RecordBase {
	type: "session";
	session: Protocol.SessionDescriptor;
}

export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ToolCall {
	callId: string;
	itemId?: string;
	name: string;
	arguments: string;
}

export type Message =
	| { role: "user"; content: string }
	| { role: "developer"; content: string }
	| {
			role: "assistant";
			content: string;
			toolCalls?: ToolCall[];
			reasoning?: unknown[];
			reasoningSummary?: string;
			provider?: Protocol.Provider;
			model?: string;
			usage?: Protocol.Usage;
			reasoningEffort?: Protocol.ReasoningEffort;
	  }
	| {
			role: "tool";
			toolCallId: string;
			content: string;
			status: "ok" | "error";
			details?: Protocol.ToolDetails;
	  };

export interface CompactionTemplate {
	systemPrompt: string;
	initialInstructions: string;
	updateInstructions: string;
}

// The model-visible prompts and tool schemas. Stored definitions preserve what later turns used
// when the executable definition differs.
export interface Definition {
	systemPrompt: string;
	tools: Tool[];
	compaction: CompactionTemplate;
}

export interface DefinitionRecord extends RecordBase, Definition {
	type: "definition";
}

export interface EventRecord extends RecordBase {
	type: "event";
	event: Protocol.Event;
}

export interface ConversationRecord extends RecordBase {
	type: "conversation";
	id: string;
	parentId: string | null;
	turnId: Protocol.TurnId;
	messageId?: Protocol.MessageId;
	message: Message;
}

export interface IdentityRecord extends RecordBase {
	type: "identity";
	identity: Protocol.Identity;
}

export interface AssistantRecord extends RecordBase {
	type: "assistant";
	message: Protocol.AssistantMessage;
}

export interface CompactionRecord extends RecordBase {
	type: "compaction";
	turnId: Protocol.TurnId;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	tokensAfter: number;
	budgetChars: number;
	reasoningEffort: Protocol.ReasoningEffort | null;
}

export interface PruneRecord extends RecordBase {
	type: "prune";
	toolCallIds: string[];
	tokensBefore: number;
	tokensAfter: number;
}

export interface StatsRecord extends RecordBase {
	type: "stats";
	contextTokens: number;
	model: Protocol.Model | null;
}

export type StoredRecord =
	| SessionRecord
	| DefinitionRecord
	| EventRecord
	| ConversationRecord
	| IdentityRecord
	| AssistantRecord
	| CompactionRecord
	| PruneRecord
	| StatsRecord;

export type Payload =
	| { type: "session"; session: Protocol.SessionDescriptor }
	| ({ type: "definition" } & Definition)
	| { type: "event"; event: Protocol.Event }
	| {
			type: "conversation";
			id: string;
			parentId: string | null;
			turnId: Protocol.TurnId;
			messageId?: Protocol.MessageId;
			message: Message;
	  }
	| { type: "identity"; identity: Protocol.Identity }
	| { type: "assistant"; message: Protocol.AssistantMessage }
	| {
			type: "compaction";
			turnId: Protocol.TurnId;
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			tokensAfter: number;
			budgetChars: number;
			reasoningEffort: Protocol.ReasoningEffort | null;
	  }
	| {
			type: "prune";
			toolCallIds: string[];
			tokensBefore: number;
			tokensAfter: number;
	  }
	| { type: "stats"; contextTokens: number; model: Protocol.Model | null };

export interface StoredSession {
	log: SessionLog;
	records: StoredRecord[];
	session: Protocol.SessionDescriptor;
}

// A session discovered by the startup scan: the header descriptor (updatedAt taken from file
// mtime), its log path and project bucket, and whether the log tail shows an empty queue.
export interface CatalogedSession {
	session: Protocol.SessionDescriptor;
	path: string;
	projectKey: string;
	idle: boolean;
}

export interface StoreOptions {
	baseDir?: string;
}

// Each append becomes one filesystem write, and the promise chain prevents records from interleaving.
export class SessionLog {
	readonly path: string;
	#lastRecordId: string | null;
	readonly #recordIds: Set<string>;
	#pending = Promise.resolve();

	constructor(path: string, lastRecordId: string | null, recordIds: Iterable<string> = []) {
		this.path = path;
		this.#lastRecordId = lastRecordId;
		this.#recordIds = new Set(recordIds);
	}

	get lastRecordId(): string | null {
		return this.#lastRecordId;
	}

	append(payloads: Payload[]): Promise<StoredRecord[]> {
		const operation = this.#pending.then(async () => {
			const records: StoredRecord[] = [];
			let lastRecordId = this.#lastRecordId;
			for (const payload of payloads) {
				const record = {
					...payload,
					version: STORE_VERSION,
					recordId: randomUUID(),
					previousRecordId: lastRecordId,
					at: new Date().toISOString(),
				} as StoredRecord;
				records.push(record);
				lastRecordId = record.recordId;
			}
			if (records.length > 0) {
				await appendFile(this.path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			}
			this.#lastRecordId = lastRecordId;
			for (const record of records) this.#recordIds.add(record.recordId);
			return records;
		});
		this.#pending = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	appendRecords(records: StoredRecord[]): Promise<{ written: StoredRecord[]; skipped: StoredRecord[] }> {
		const operation = this.#pending.then(async () => {
			const written: StoredRecord[] = [];
			const skipped: StoredRecord[] = [];
			let lastRecordId = this.#lastRecordId;
			for (const record of records) {
				validateRecord(record, this.path);
				if (this.#recordIds.has(record.recordId)) {
					skipped.push(record);
					continue;
				}
				if (record.previousRecordId !== lastRecordId) {
					throw new Error(
						`Broken record chain in ${this.path}: expected ${lastRecordId ?? "null"}, got ${record.previousRecordId ?? "null"}`,
					);
				}
				written.push(record);
				lastRecordId = record.recordId;
			}
			if (written.length > 0) {
				await appendFile(this.path, `${written.map((record) => JSON.stringify(record)).join("\n")}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
			}
			this.#lastRecordId = lastRecordId;
			for (const record of written) this.#recordIds.add(record.recordId);
			return { written, skipped };
		});
		this.#pending = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}

export class SessionStore {
	readonly baseDir: string;

	constructor(options: StoreOptions = {}) {
		this.baseDir = options.baseDir ?? defaultSessionDir();
	}

	async createLog(projectRoot: string, sessionId: Protocol.SessionId): Promise<SessionLog> {
		const directory = join(this.baseDir, Protocol.projectKey(projectRoot), sessionId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		return new SessionLog(join(directory, SESSION_FILE), null);
	}

	logPath(key: string, sessionId: Protocol.SessionId): string {
		return join(this.baseDir, key, sessionId, SESSION_FILE);
	}

	stagingDir(): string {
		const parent = join(this.baseDir, ".staging");
		const directory = join(parent, randomUUID());
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		mkdirSync(directory, { mode: 0o700 });
		return directory;
	}

	placeLog(
		stagedPath: string,
		key: string,
		sessionId: Protocol.SessionId,
	): { placed: true; path: string } | { placed: false } {
		const path = this.logPath(key, sessionId);
		if (existsSync(path)) return { placed: false };
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		renameSync(stagedPath, path);
		return { placed: true, path };
	}

	removeStaging(directory: string): void {
		rmSync(directory, { recursive: true, force: true });
	}

	// Discovers sessions by reading only each log's header line and a bounded tail, so startup
	// cost stays flat in history size. Full replay happens in loadSession.
	async scanCatalog(): Promise<{
		sessions: CatalogedSession[];
		unreadable: Array<{ id: Protocol.SessionId; projectKey: string; error: string }>;
	}> {
		rmSync(join(this.baseDir, ".staging"), { recursive: true, force: true });
		await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
		const projects = [];
		for await (const entry of await opendir(this.baseDir)) {
			if (entry.isDirectory() && Protocol.PROJECT_KEY_PATTERN.test(entry.name)) projects.push(entry);
		}
		const sessions: CatalogedSession[] = [];
		const unreadable: Array<{ id: Protocol.SessionId; projectKey: string; error: string }> = [];
		for (const project of projects) {
			const projectDir = join(this.baseDir, project.name);
			const directories = [];
			for await (const entry of await opendir(projectDir)) {
				if (entry.isDirectory()) directories.push(entry);
			}
			for (const directory of directories) {
				const path = join(projectDir, directory.name, SESSION_FILE);
				try {
					const scanned = await scanSession(path);
					sessions.push({ ...scanned, path, projectKey: project.name });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					unreadable.push({
						id: directory.name,
						error: error instanceof Error ? error.message : String(error),
						projectKey: project.name,
					});
				}
			}
		}
		return {
			sessions: sessions.sort((left, right) => left.session.createdAt.localeCompare(right.session.createdAt)),
			unreadable,
		};
	}

	async loadSession(path: string): Promise<StoredSession> {
		const records = await readRecords(path);
		const first = records[0];
		if (!first || first.type !== "session") throw new Error(`Session log ${path} has no session record`);
		const updatedAt = records.at(-1)?.at ?? first.session.updatedAt;
		const session = { ...first.session, updatedAt };
		return {
			log: new SessionLog(
				path,
				records.at(-1)?.recordId ?? null,
				records.map((record) => record.recordId),
			),
			records,
			session,
		};
	}
}

export function defaultSessionDir(): string {
	const override = process.env.KER_SESSION_DIR;
	if (override) return override;
	return join(homedir(), ".ker", "sessions");
}

// Reads the header line for the descriptor and a bounded tail for idle classification; the
// header must be the session record. Throws on anything unreadable at this depth.
async function scanSession(path: string): Promise<{ session: Protocol.SessionDescriptor; idle: boolean }> {
	const handle = await open(path, "r");
	try {
		const stats = await handle.stat();
		const head = Buffer.alloc(Math.min(stats.size, HEADER_SCAN_BYTES));
		await handle.read(head, 0, head.length, 0);
		const newline = head.indexOf(10);
		if (newline === -1 && stats.size > head.length) throw new Error(`Session header too long in ${path}`);
		const header = parseRecord(head.subarray(0, newline === -1 ? head.length : newline).toString("utf8"), path);
		if (header.type !== "session" || header.previousRecordId !== null) {
			throw new Error(`Session log ${path} has no session record`);
		}
		const session = { ...header.session, updatedAt: stats.mtime.toISOString() };
		const tailOffset = Math.max(0, stats.size - TAIL_SCAN_BYTES);
		const tail = stats.size <= head.length ? head : Buffer.alloc(Math.min(stats.size, TAIL_SCAN_BYTES));
		if (tail !== head) await handle.read(tail, 0, tail.length, tailOffset);
		return { session, idle: isIdleTail(tail, tailOffset, path) };
	} finally {
		await handle.close();
	}
}

// Definition records do not change queue state, so idle classification skips them while walking
// backward to the latest queue record. An ambiguous tail reads as busy so recovery loads the log.
function isIdleTail(tail: Buffer, tailOffset: number, path: string): boolean {
	if (tail.length === 0 || tail[tail.length - 1] !== 10) return false;
	const body = tail.subarray(0, tail.length - 1);
	for (let end = body.length; end > 0; ) {
		const start = body.lastIndexOf(10, end - 1);
		if (start === -1 && tailOffset > 0) return false;
		let record: StoredRecord;
		try {
			record = parseRecord(body.subarray(start + 1, end).toString("utf8"), path);
		} catch {
			return false;
		}
		if (record.type === "definition") {
			end = start;
			continue;
		}
		if (record.type === "session") return start === -1 && tailOffset === 0;
		return (
			record.type === "event" &&
			record.event.type === "queue_changed" &&
			!record.event.queue.running &&
			record.event.queue.waiting.length === 0
		);
	}
	return false;
}

// A torn final JSON fragment is discarded. Every complete malformed line invalidates the session.
export async function readRecords(path: string): Promise<StoredRecord[]> {
	return readRecordsWithInitial(path, null);
}

export async function readRecordFragment(path: string): Promise<StoredRecord[]> {
	return readRecordsWithInitial(path, undefined);
}

async function readRecordsWithInitial(
	path: string,
	initialPreviousId: string | null | undefined,
): Promise<StoredRecord[]> {
	const contents = await readFile(path);
	const records: StoredRecord[] = [];
	let offset = 0;
	let previousId: string | null | undefined = initialPreviousId;
	for (let newline = contents.indexOf(10, offset); newline !== -1; newline = contents.indexOf(10, offset)) {
		const line = contents.subarray(offset, newline).toString("utf8");
		if (!line) throw new Error(`Malformed blank record in ${path}`);
		const record = parseRecord(line, path);
		if (previousId === undefined) previousId = record.previousRecordId;
		if (record.previousRecordId !== previousId) throw new Error(`Broken record chain in ${path}`);
		records.push(record);
		previousId = record.recordId;
		offset = newline + 1;
	}
	if (offset === contents.length) return records;
	const finalLine = contents.subarray(offset).toString("utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(finalLine) as unknown;
	} catch (error) {
		if (records.length === 0 || !isIncompleteJson(finalLine, error)) throw error;
		const handle = await open(path, "r+");
		try {
			await handle.truncate(offset);
		} finally {
			await handle.close();
		}
		return records;
	}
	const record = validateRecord(parsed, path);
	if (record.previousRecordId !== previousId) throw new Error(`Broken record chain in ${path}`);
	records.push(record);
	await appendFile(path, "\n", "utf8");
	return records;
}

export function parseRecords(contents: string, path = "<memory>"): StoredRecord[] {
	const records: StoredRecord[] = [];
	let previousId: string | null = null;
	const lines = contents.endsWith("\n") ? contents.slice(0, -1).split("\n") : contents.split("\n");
	if (lines.length === 1 && lines[0] === "") return records;
	for (const line of lines) {
		if (!line) throw new Error(`Malformed blank record in ${path}`);
		const record = parseRecord(line, path);
		if (record.previousRecordId !== previousId) throw new Error(`Broken record chain in ${path}`);
		records.push(record);
		previousId = record.recordId;
	}
	return records;
}

function isIncompleteJson(value: string, error: unknown): boolean {
	if (!(error instanceof SyntaxError)) return false;
	if (error.message.includes("Unexpected end of JSON input")) return true;
	const position = error.message.match(/position (\d+)/)?.[1];
	return position !== undefined && Number(position) === value.length;
}

function parseRecord(line: string, path: string): StoredRecord {
	return validateRecord(JSON.parse(line) as unknown, path);
}

function validateRecord(parsed: unknown, path: string): StoredRecord {
	if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
		throw new Error(`Malformed record in ${path}`);
	}
	if (parsed.version !== STORE_VERSION) {
		throw new Error(`Unsupported store version ${String(parsed.version)} in ${path}`);
	}
	if (
		!("recordId" in parsed) ||
		typeof parsed.recordId !== "string" ||
		!("previousRecordId" in parsed) ||
		(parsed.previousRecordId !== null && typeof parsed.previousRecordId !== "string") ||
		!("at" in parsed) ||
		typeof parsed.at !== "string" ||
		!("type" in parsed) ||
		typeof parsed.type !== "string"
	) {
		throw new Error(`Malformed record in ${path}`);
	}
	return parsed as StoredRecord;
}
