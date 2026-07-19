import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

export interface Lock {
	release(): void;
}

// Cross-process mutex backed by a SQLite write transaction. BEGIN IMMEDIATE takes the database
// file's write lock through the OS, which releases it if the holder crashes, so no PID files or
// stale-lock recovery are needed. Waiting never uses SQLite's busy timeout, because node:sqlite is
// synchronous and would block the event loop; contention surfaces as an immediate SQLITE_BUSY and
// is retried after an async sleep until the deadline.
export async function acquireLock(path: string, timeoutMs: number, signal?: AbortSignal): Promise<Lock> {
	signal?.throwIfAborted();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(path);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			db.exec("BEGIN IMMEDIATE");
			return {
				release: () => {
					try {
						db.exec("ROLLBACK");
					} finally {
						db.close();
					}
				},
			};
		} catch (err) {
			if (!isBusy(err)) {
				db.close();
				throw err;
			}
			if (Date.now() >= deadline) {
				db.close();
				throw new Error(`Timed out waiting for the lock at ${path}`);
			}
			try {
				await sleep(50 + Math.random() * 100, undefined, { signal });
			} catch (error) {
				db.close();
				throw error;
			}
		}
	}
}

function isBusy(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { errcode?: unknown }).errcode === 5;
}
