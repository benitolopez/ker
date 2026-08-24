import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as Protocol from "@ker-ai/protocol";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { CATALOG_VERSION, DDL, session } from "./schema.ts";
import { type CatalogedSession, projectKey } from "./store.ts";

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export interface CatalogRow {
	id: Protocol.SessionId;
	project_key: string;
	project_root: string | null;
	cwd: string | null;
	title: string | null;
	status: "idle" | "busy" | "unreadable";
	error: string | null;
	created_at: string | null;
	updated_at: string | null;
}

type CatalogScan = {
	sessions: CatalogedSession[];
	unreadable: Array<{ id: Protocol.SessionId; projectKey: string; error: string }>;
};

export class Catalog {
	readonly #client: DatabaseSync;
	readonly #db: ReturnType<typeof drizzle>;

	private constructor(client: DatabaseSync) {
		this.#client = client;
		this.#db = drizzle({ client });
	}

	// An incompatible or corrupt catalog is deleted because every row can be rebuilt from the session logs.
	static open(path: string): Catalog {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const existed = existsSync(path);
		if (!existed) {
			const created = openDatabase(path).client;
			initializeDatabase(created);
			return new Catalog(created);
		}

		const opened = openExistingDatabase(path);
		if (opened?.version === CATALOG_VERSION) return new Catalog(opened.client);
		opened?.client.close();
		return new Catalog(recreateDatabase(path));
	}

	// Startup reconciliation preserves titles while refreshing all data derived from the logs.
	reconcile(scan: CatalogScan): void {
		this.#db.transaction((tx) => {
			const scannedIds = new Set<Protocol.SessionId>();
			for (const entry of scan.sessions) {
				const descriptor = entry.session;
				scannedIds.add(descriptor.id);
				tx.insert(session)
					.values({
						id: descriptor.id,
						project_key: entry.projectKey,
						project_root: descriptor.projectRoot,
						cwd: descriptor.cwd,
						status: entry.idle ? "idle" : "busy",
						error: null,
						created_at: descriptor.createdAt,
						updated_at: descriptor.updatedAt,
					})
					.onConflictDoUpdate({
						target: session.id,
						set: {
							project_key: entry.projectKey,
							project_root: descriptor.projectRoot,
							cwd: descriptor.cwd,
							status: entry.idle ? "idle" : "busy",
							error: null,
							created_at: descriptor.createdAt,
							updated_at: descriptor.updatedAt,
						},
					})
					.run();
			}
			for (const entry of scan.unreadable) {
				scannedIds.add(entry.id);
				tx.insert(session)
					.values({
						id: entry.id,
						project_key: entry.projectKey,
						status: "unreadable",
						error: entry.error,
					})
					.onConflictDoUpdate({
						target: session.id,
						set: {
							project_key: entry.projectKey,
							status: "unreadable",
							error: entry.error,
						},
					})
					.run();
			}
			for (const row of tx.select({ id: session.id }).from(session).all()) {
				if (!scannedIds.has(row.id)) tx.delete(session).where(eq(session.id, row.id)).run();
			}
		});
	}

	upsertCreated(descriptor: Protocol.SessionDescriptor): void {
		const key = projectKey(descriptor.projectRoot);
		this.#db
			.insert(session)
			.values({
				id: descriptor.id,
				project_key: key,
				project_root: descriptor.projectRoot,
				cwd: descriptor.cwd,
				status: "idle",
				error: null,
				created_at: descriptor.createdAt,
				updated_at: descriptor.updatedAt,
			})
			.onConflictDoUpdate({
				target: session.id,
				set: {
					project_key: key,
					project_root: descriptor.projectRoot,
					cwd: descriptor.cwd,
					status: "idle",
					error: null,
					created_at: descriptor.createdAt,
					updated_at: descriptor.updatedAt,
				},
			})
			.run();
	}

	touch(id: Protocol.SessionId, update: { updatedAt: string; status: "idle" | "busy" }): void {
		this.#db
			.update(session)
			.set({ updated_at: update.updatedAt, status: update.status, error: null })
			.where(eq(session.id, id))
			.run();
	}

	setTitleIfEmpty(id: Protocol.SessionId, title: string): void {
		this.#db
			.update(session)
			.set({ title })
			.where(and(eq(session.id, id), isNull(session.title)))
			.run();
	}

	markUnreadable(id: Protocol.SessionId, error: string): void {
		this.#db.update(session).set({ status: "unreadable", error }).where(eq(session.id, id)).run();
	}

	get(id: Protocol.SessionId): CatalogRow | undefined {
		return this.#db.select().from(session).where(eq(session.id, id)).get();
	}

	list(scope?: { cwd: string; projectKey: string }): CatalogRow[] {
		if (!scope) return this.#db.select().from(session).orderBy(asc(session.created_at)).all();
		return this.#db
			.select()
			.from(session)
			.where(
				or(
					eq(session.cwd, scope.cwd),
					and(eq(session.status, "unreadable"), eq(session.project_key, scope.projectKey)),
				),
			)
			.orderBy(asc(session.created_at))
			.all();
	}

	close(): void {
		this.#client.close();
	}
}

export function defaultCatalogPath(): string {
	return process.env.KER_CATALOG_PATH ?? join(homedir(), ".ker", "catalog.db");
}

function openDatabase(path: string): { client: DatabaseSync; version: number } {
	const client = new DatabaseSync(path);
	try {
		chmodSync(path, 0o600);
		client.exec("PRAGMA journal_mode = WAL");
		client.exec("PRAGMA synchronous = NORMAL");
		const version = client.prepare("PRAGMA user_version").get() as { user_version: number };
		return { client, version: version.user_version };
	} catch (error) {
		client.close();
		throw error;
	}
}

function openExistingDatabase(path: string): ReturnType<typeof openDatabase> | undefined {
	try {
		return openDatabase(path);
	} catch (error) {
		if (isCorruptDatabase(error)) return undefined;
		throw error;
	}
}

function recreateDatabase(path: string): DatabaseSync {
	for (const candidate of [path, `${path}-wal`, `${path}-shm`]) rmSync(candidate, { force: true });
	const client = openDatabase(path).client;
	initializeDatabase(client);
	return client;
}

function isCorruptDatabase(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
	if (typeof error.errcode !== "number") return false;
	const primaryCode = error.errcode & 0xff;
	return primaryCode === SQLITE_CORRUPT || primaryCode === SQLITE_NOTADB;
}

function initializeDatabase(client: DatabaseSync): void {
	client.exec(DDL);
	client.exec(`PRAGMA user_version = ${CATALOG_VERSION}`);
}
