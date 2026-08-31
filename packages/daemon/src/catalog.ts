import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as Protocol from "@ker-ai/protocol";
import { and, asc, count, eq, getTableColumns, isNull, max, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import type { NodeIdentity } from "./identity.ts";
import { CATALOG_VERSION, DDL, MIGRATIONS, node, project, session, workspace } from "./schema.ts";
import { projectKey } from "./store.ts";

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export interface CatalogRow {
	id: Protocol.SessionId;
	project_key: string;
	cwd: string | null;
	title: string | null;
	status: "idle" | "busy" | "unreadable";
	error: string | null;
	created_at: string | null;
	updated_at: string | null;
	project_id: Protocol.ProjectId | null;
	workspace_id: Protocol.WorkspaceId | null;
	node_id: Protocol.NodeId | null;
}

export type CatalogListRow = CatalogRow & { project_name: string | null };

export interface WorkspaceBinding {
	projectId: Protocol.ProjectId;
	projectName: string;
	workspaceId: Protocol.WorkspaceId;
	nodeId: Protocol.NodeId;
	rootPath: string;
	gitRemote: string | null;
}

type CatalogScan = {
	sessions: Array<{ session: Protocol.SessionDescriptor; projectKey: string; idle: boolean }>;
	unreadable: Array<{ id: Protocol.SessionId; projectKey: string; error: string }>;
};

export class Catalog {
	readonly #client: DatabaseSync;
	readonly #db: ReturnType<typeof drizzle>;

	private constructor(client: DatabaseSync) {
		this.#client = client;
		this.#db = drizzle({ client });
	}

	static open(path: string): Catalog {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		if (!existsSync(path)) {
			const client = openDatabase(path).client;
			initializeDatabase(client);
			return new Catalog(client);
		}

		const opened = openExistingDatabase(path);
		if (!opened) return new Catalog(rebuildDatabase(path, "the catalog database is corrupt"));
		if (opened.version === CATALOG_VERSION) return new Catalog(opened.client);
		if (opened.version > CATALOG_VERSION) {
			opened.client.close();
			throw new Error(`${path} was created by a newer ker — refusing to open`);
		}
		if (opened.version === 0) {
			opened.client.close();
			return new Catalog(rebuildDatabase(path, "the existing catalog has no schema version"));
		}

		try {
			migrateDatabase(opened.client, opened.version);
			return new Catalog(opened.client);
		} catch (error) {
			opened.client.close();
			if (isCorruptDatabase(error)) {
				return new Catalog(rebuildDatabase(path, "the catalog database became corrupt during migration"));
			}
			throw error;
		}
	}

	upsertNode(identity: NodeIdentity): void {
		this.#db
			.insert(node)
			.values({ id: identity.id, name: identity.name, created_at: identity.createdAt })
			.onConflictDoUpdate({ target: node.id, set: { name: identity.name } })
			.run();
	}

	findWorkspaceByRoot(nodeId: Protocol.NodeId, rootPath: string): WorkspaceBinding | undefined {
		return this.#db
			.select({
				projectId: project.id,
				projectName: project.name,
				workspaceId: workspace.id,
				nodeId: workspace.node_id,
				rootPath: workspace.root_path,
				gitRemote: workspace.git_remote,
			})
			.from(workspace)
			.innerJoin(project, eq(workspace.project_id, project.id))
			.where(and(eq(workspace.node_id, nodeId), eq(workspace.root_path, rootPath)))
			.get();
	}

	projectWorkspaces(projectId: Protocol.ProjectId): WorkspaceBinding[] {
		return this.#db
			.select({
				projectId: project.id,
				projectName: project.name,
				workspaceId: workspace.id,
				nodeId: workspace.node_id,
				rootPath: workspace.root_path,
				gitRemote: workspace.git_remote,
			})
			.from(workspace)
			.innerJoin(project, eq(workspace.project_id, project.id))
			.where(eq(workspace.project_id, projectId))
			.all();
	}

	createWorkspace(input: {
		nodeId: Protocol.NodeId;
		rootPath: string;
		projectName: string;
		gitRemote: string | null;
	}): WorkspaceBinding {
		try {
			return this.#db.transaction((tx) => {
				const now = new Date().toISOString();
				const projectId = randomUUID();
				const workspaceId = randomUUID();
				tx.insert(project).values({ id: projectId, name: input.projectName, created_at: now }).run();
				tx.insert(workspace)
					.values({
						id: workspaceId,
						project_id: projectId,
						node_id: input.nodeId,
						root_path: input.rootPath,
						git_remote: input.gitRemote,
						created_at: now,
					})
					.run();
				return {
					projectId,
					projectName: input.projectName,
					workspaceId,
					nodeId: input.nodeId,
					rootPath: input.rootPath,
					gitRemote: input.gitRemote,
				};
			});
		} catch (error) {
			const existing = this.findWorkspaceByRoot(input.nodeId, input.rootPath);
			if (existing) return existing;
			throw error;
		}
	}

	// Startup reconciliation refreshes log-derived fields without deleting logical entities.
	reconcile(scan: CatalogScan, nodeId: Protocol.NodeId): void {
		this.#db.transaction((tx) => {
			const bindingsByRoot = new Map<string, WorkspaceBinding>();
			const bindingsByKey = new Map<string, WorkspaceBinding>();
			const existingBindings = tx
				.select({
					projectId: project.id,
					projectName: project.name,
					workspaceId: workspace.id,
					nodeId: workspace.node_id,
					rootPath: workspace.root_path,
					gitRemote: workspace.git_remote,
				})
				.from(workspace)
				.innerJoin(project, eq(workspace.project_id, project.id))
				.where(eq(workspace.node_id, nodeId))
				.all();
			for (const binding of existingBindings) {
				bindingsByRoot.set(binding.rootPath, binding);
				bindingsByKey.set(projectKey(binding.rootPath), binding);
			}

			const scannedIds = new Set<Protocol.SessionId>();
			for (const entry of scan.sessions) {
				const descriptor = entry.session;
				scannedIds.add(descriptor.id);
				const existing = bindingsByRoot.get(descriptor.projectRoot);
				const binding =
					existing ??
					(() => {
						const now = new Date().toISOString();
						const projectId = randomUUID();
						const workspaceId = randomUUID();
						const projectName = basename(descriptor.projectRoot) || descriptor.projectRoot;
						tx.insert(project).values({ id: projectId, name: projectName, created_at: now }).run();
						tx.insert(workspace)
							.values({
								id: workspaceId,
								project_id: projectId,
								node_id: nodeId,
								root_path: descriptor.projectRoot,
								git_remote: null,
								created_at: now,
							})
							.run();
						return {
							projectId,
							projectName,
							workspaceId,
							nodeId,
							rootPath: descriptor.projectRoot,
							gitRemote: null,
						};
					})();
				bindingsByRoot.set(binding.rootPath, binding);
				bindingsByKey.set(entry.projectKey, binding);
				tx.insert(session)
					.values({
						id: descriptor.id,
						project_key: entry.projectKey,
						cwd: descriptor.cwd,
						status: entry.idle ? "idle" : "busy",
						error: null,
						created_at: descriptor.createdAt,
						updated_at: descriptor.updatedAt,
						project_id: binding.projectId,
						workspace_id: binding.workspaceId,
						node_id: binding.nodeId,
					})
					.onConflictDoUpdate({
						target: session.id,
						set: {
							project_key: entry.projectKey,
							cwd: descriptor.cwd,
							status: entry.idle ? "idle" : "busy",
							error: null,
							created_at: descriptor.createdAt,
							updated_at: descriptor.updatedAt,
							project_id: binding.projectId,
							workspace_id: binding.workspaceId,
							node_id: binding.nodeId,
						},
					})
					.run();
			}
			for (const entry of scan.unreadable) {
				scannedIds.add(entry.id);
				const binding = bindingsByKey.get(entry.projectKey);
				tx.insert(session)
					.values({
						id: entry.id,
						project_key: entry.projectKey,
						status: "unreadable",
						error: entry.error,
						...(binding
							? {
									project_id: binding.projectId,
									workspace_id: binding.workspaceId,
									node_id: binding.nodeId,
								}
							: {}),
					})
					.onConflictDoUpdate({
						target: session.id,
						set: {
							project_key: entry.projectKey,
							status: "unreadable",
							error: entry.error,
							...(binding
								? {
										project_id: binding.projectId,
										workspace_id: binding.workspaceId,
										node_id: binding.nodeId,
									}
								: {}),
						},
					})
					.run();
			}
			for (const row of tx.select({ id: session.id }).from(session).all()) {
				if (!scannedIds.has(row.id)) tx.delete(session).where(eq(session.id, row.id)).run();
			}
		});
	}

	upsertCreated(descriptor: Protocol.SessionDescriptor, binding: WorkspaceBinding): void {
		const key = projectKey(descriptor.projectRoot);
		this.#db
			.insert(session)
			.values({
				id: descriptor.id,
				project_key: key,
				cwd: descriptor.cwd,
				status: "idle",
				error: null,
				created_at: descriptor.createdAt,
				updated_at: descriptor.updatedAt,
				project_id: binding.projectId,
				workspace_id: binding.workspaceId,
				node_id: binding.nodeId,
			})
			.onConflictDoUpdate({
				target: session.id,
				set: {
					project_key: key,
					cwd: descriptor.cwd,
					status: "idle",
					error: null,
					created_at: descriptor.createdAt,
					updated_at: descriptor.updatedAt,
					project_id: binding.projectId,
					workspace_id: binding.workspaceId,
					node_id: binding.nodeId,
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

	list(scope?: { nodeId: Protocol.NodeId; rootPath: string } | { projectId: Protocol.ProjectId }): CatalogListRow[] {
		const selection = { ...getTableColumns(session), project_name: project.name };
		if (!scope) {
			return this.#db
				.select(selection)
				.from(session)
				.leftJoin(project, eq(session.project_id, project.id))
				.orderBy(asc(session.created_at))
				.all();
		}
		if ("projectId" in scope) {
			return this.#db
				.select(selection)
				.from(session)
				.leftJoin(project, eq(session.project_id, project.id))
				.where(eq(session.project_id, scope.projectId))
				.orderBy(asc(session.created_at))
				.all();
		}
		const binding = this.findWorkspaceByRoot(scope.nodeId, scope.rootPath);
		const unreadableMatch = and(eq(session.status, "unreadable"), eq(session.project_key, projectKey(scope.rootPath)));
		return this.#db
			.select(selection)
			.from(session)
			.leftJoin(project, eq(session.project_id, project.id))
			.where(binding ? or(eq(session.project_id, binding.projectId), unreadableMatch) : unreadableMatch)
			.orderBy(asc(session.created_at))
			.all();
	}

	listProjects(): Protocol.Project[] {
		return this.#db
			.select({
				id: project.id,
				name: project.name,
				created_at: project.created_at,
				session_count: count(session.id),
				last_activity_at: max(session.updated_at),
			})
			.from(project)
			.leftJoin(session, eq(session.project_id, project.id))
			.groupBy(project.id)
			.orderBy(asc(project.created_at))
			.all()
			.map((row) => ({
				id: row.id,
				name: row.name,
				createdAt: row.created_at,
				sessionCount: row.session_count,
				lastActivityAt: row.last_activity_at,
			}));
	}

	projectExists(id: Protocol.ProjectId): boolean {
		return this.#db.select({ id: project.id }).from(project).where(eq(project.id, id)).get() !== undefined;
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
		client.exec("PRAGMA foreign_keys = ON");
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

function migrateDatabase(client: DatabaseSync, fromVersion: number): void {
	client.exec("BEGIN IMMEDIATE");
	try {
		for (let version = fromVersion + 1; version <= CATALOG_VERSION; version++) {
			const migration = MIGRATIONS[version];
			if (!migration) throw new Error(`Catalog migration ${version - 1}→${version} is missing`);
			client.exec(migration);
			client.exec(`PRAGMA user_version = ${version}`);
		}
		client.exec("COMMIT");
	} catch (error) {
		try {
			client.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}

function rebuildDatabase(path: string, reason: string): DatabaseSync {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const preservedPath = `${path}.corrupt-${timestamp}`;
	for (const suffix of ["", "-wal", "-shm"]) {
		const candidate = `${path}${suffix}`;
		if (existsSync(candidate)) renameSync(candidate, `${preservedPath}${suffix}`);
	}
	console.error(`ker: ${reason}; preserved it at ${preservedPath} and created a fresh catalog`);
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
