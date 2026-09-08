import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import type * as Protocol from "@ker-ai/protocol";
import type { Payload, StoredRecord } from "@ker-ai/store";
import { readRecordFragment, SessionLog } from "@ker-ai/store";

interface SpoolState {
	log: SessionLog;
	records: StoredRecord[];
}

export class Spool {
	readonly directory: string;
	readonly #states = new Map<Protocol.SessionId, SpoolState>();
	readonly #locks = new Map<Protocol.SessionId, Promise<void>>();

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}

	async open(sessionId: Protocol.SessionId, lastRecordId: string | null): Promise<void> {
		await this.#withLock(sessionId, () => this.#open(sessionId, lastRecordId));
	}

	async append(sessionId: Protocol.SessionId, payloads: Payload[]): Promise<StoredRecord[]> {
		return this.#withLock(sessionId, async () => {
			if (!this.#states.has(sessionId)) await this.#open(sessionId, null);
			const state = this.#states.get(sessionId);
			if (!state) throw new Error(`Spool for ${sessionId} did not open`);
			const records = await state.log.append(payloads);
			state.records.push(...records);
			return records;
		});
	}

	pending(sessionId: Protocol.SessionId): StoredRecord[] {
		return [...(this.#states.get(sessionId)?.records ?? [])];
	}

	async acknowledge(sessionId: Protocol.SessionId, recordId: string): Promise<void> {
		await this.#withLock(sessionId, async () => {
			const state = this.#states.get(sessionId);
			if (!state) return;
			const index = state.records.findIndex((record) => record.recordId === recordId);
			if (index === -1) return;
			state.records.splice(0, index + 1);
			if (state.records.length === 0) {
				if (existsSync(state.log.path)) unlinkSync(state.log.path);
				return;
			}
			writeFileSync(state.log.path, `${state.records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
		});
	}

	async drop(sessionId: Protocol.SessionId): Promise<void> {
		await this.#withLock(sessionId, async () => {
			const state = this.#states.get(sessionId);
			const path = state?.log.path ?? this.#path(sessionId);
			if (existsSync(path)) unlinkSync(path);
			this.#states.delete(sessionId);
		});
	}

	async #open(sessionId: Protocol.SessionId, lastRecordId: string | null): Promise<void> {
		const existing = this.#states.get(sessionId);
		if (existing) {
			if (existing.records.length === 0) {
				existing.log = new SessionLog(existing.log.path, lastRecordId);
				return;
			}
			const first = existing.records[0];
			const chainStart = first?.previousRecordId;
			if (chainStart !== lastRecordId) {
				throw new Error(
					`Spool for ${sessionId} does not continue the plane record chain: expected ${lastRecordId ?? "null"}, got ${chainStart ?? "null"}`,
				);
			}
			return;
		}
		const path = this.#path(sessionId);
		const records = existsSync(path) ? await readRecordFragment(path) : [];
		const first = records[0];
		if (first && first.previousRecordId !== lastRecordId) {
			throw new Error(
				`Spool for ${sessionId} does not continue the plane record chain: expected ${lastRecordId ?? "null"}, got ${first.previousRecordId ?? "null"}`,
			);
		}
		this.#states.set(sessionId, {
			log: new SessionLog(
				path,
				records.at(-1)?.recordId ?? lastRecordId,
				records.map((record) => record.recordId),
			),
			records,
		});
	}

	async drain(): Promise<Map<Protocol.SessionId, StoredRecord[]>> {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for await (const entry of await opendir(this.directory)) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const sessionId = basename(entry.name, ".jsonl");
			if (this.#states.has(sessionId)) continue;
			const path = join(this.directory, entry.name);
			const records = await readRecordFragment(path);
			this.#states.set(sessionId, {
				log: new SessionLog(
					path,
					records.at(-1)?.recordId ?? null,
					records.map((record) => record.recordId),
				),
				records,
			});
		}
		return new Map([...this.#states].map(([sessionId, state]) => [sessionId, [...state.records]]));
	}

	#path(sessionId: Protocol.SessionId): string {
		return join(this.directory, `${sessionId}.jsonl`);
	}

	#withLock<T>(sessionId: Protocol.SessionId, operation: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(sessionId) ?? Promise.resolve();
		const running = previous.then(operation, operation);
		const settled = running.then(
			() => undefined,
			() => undefined,
		);
		this.#locks.set(sessionId, settled);
		return running.finally(() => {
			if (this.#locks.get(sessionId) === settled) this.#locks.delete(sessionId);
		});
	}
}
