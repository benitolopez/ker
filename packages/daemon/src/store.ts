import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, opendir, readFile, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, parse } from "node:path";
import type * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";

const STORE_VERSION = 2 as const;
const SESSION_FILE = "session.jsonl";

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
	message: Engine.HarnessState["messages"][number];
}

export interface IdentityRecord extends RecordBase {
	type: "identity";
	identity: Protocol.Identity;
}

export interface AssistantRecord extends RecordBase {
	type: "assistant";
	message: Protocol.AssistantMessage;
}

export type StoredRecord = SessionRecord | EventRecord | ConversationRecord | IdentityRecord | AssistantRecord;

export type Payload =
	| { type: "session"; session: Protocol.SessionDescriptor }
	| { type: "event"; event: Protocol.Event }
	| {
			type: "conversation";
			id: string;
			parentId: string | null;
			turnId: Protocol.TurnId;
			messageId?: Protocol.MessageId;
			message: Engine.HarnessState["messages"][number];
	  }
	| { type: "identity"; identity: Protocol.Identity }
	| { type: "assistant"; message: Protocol.AssistantMessage };

export interface StoredSession {
	log: SessionLog;
	records: StoredRecord[];
	session: Protocol.SessionDescriptor;
}

export interface UnreadableSession {
	id: Protocol.SessionId;
	error: string;
}

export interface StoreOptions {
	baseDir?: string;
	projectRoot: string;
}

// Each append becomes one filesystem write, and the promise chain prevents records from interleaving.
export class SessionLog {
	readonly path: string;
	#lastRecordId: string | null;
	#pending = Promise.resolve();

	constructor(path: string, lastRecordId: string | null) {
		this.path = path;
		this.#lastRecordId = lastRecordId;
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
			return records;
		});
		this.#pending = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}

export class SessionStore {
	readonly projectRoot: string;
	readonly projectDir: string;
	readonly unreadableSessions: UnreadableSession[] = [];

	constructor(options: StoreOptions) {
		this.projectRoot = options.projectRoot;
		const baseDir = options.baseDir ?? defaultSessionDir();
		const projectKey = createHash("sha256").update(options.projectRoot).digest("hex");
		this.projectDir = join(baseDir, projectKey);
	}

	async create(cwd: string): Promise<StoredSession> {
		const now = new Date().toISOString();
		const session: Protocol.SessionDescriptor = {
			id: randomUUID(),
			cwd,
			projectRoot: this.projectRoot,
			createdAt: now,
			updatedAt: now,
		};
		const directory = join(this.projectDir, session.id);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const log = new SessionLog(join(directory, SESSION_FILE), null);
		const records = await log.append([{ type: "session", session }]);
		return { log, records, session };
	}

	async loadAll(): Promise<StoredSession[]> {
		this.unreadableSessions.length = 0;
		await mkdir(this.projectDir, { recursive: true, mode: 0o700 });
		const directories = [];
		for await (const entry of await opendir(this.projectDir)) {
			if (entry.isDirectory()) directories.push(entry);
		}
		const sessions: StoredSession[] = [];
		for (const directory of directories) {
			const path = join(this.projectDir, directory.name, SESSION_FILE);
			try {
				const records = await readRecords(path);
				const first = records[0];
				if (!first || first.type !== "session") throw new Error(`Session log ${path} has no session record`);
				const updatedAt = records.at(-1)?.at ?? first.session.updatedAt;
				const session = { ...first.session, updatedAt };
				sessions.push({ log: new SessionLog(path, records.at(-1)?.recordId ?? null), records, session });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				this.unreadableSessions.push({
					id: directory.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return sessions.sort((left, right) => left.session.createdAt.localeCompare(right.session.createdAt));
	}
}

export async function canonicalProjectRoot(cwd: string): Promise<string> {
	const canonicalCwd = await realpath(cwd);
	const root = parse(canonicalCwd).root;
	for (let candidate = canonicalCwd; ; candidate = dirname(candidate)) {
		try {
			await stat(join(candidate, ".git"));
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (candidate === root) return canonicalCwd;
	}
}

export function defaultSessionDir(): string {
	const override = process.env.KER_SESSION_DIR;
	if (override) return override;
	if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "ker", "sessions");
	if (platform() === "win32")
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "ker", "sessions");
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ker", "sessions");
}

// A torn final JSON fragment in a v2 log is discarded. Every complete malformed line invalidates the session.
async function readRecords(path: string): Promise<StoredRecord[]> {
	const contents = await readFile(path);
	const records: StoredRecord[] = [];
	let offset = 0;
	let previousId: string | null = null;
	for (let newline = contents.indexOf(10, offset); newline !== -1; newline = contents.indexOf(10, offset)) {
		const line = contents.subarray(offset, newline).toString("utf8");
		if (!line) throw new Error(`Malformed blank record in ${path}`);
		const record = parseRecord(line, path);
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
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed) ||
		parsed.version !== STORE_VERSION ||
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
