import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Protocol from "@ker-ai/protocol";
import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, max, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import {
	CATALOG_VERSION,
	DDL,
	device,
	document,
	MIGRATIONS,
	node,
	one_time_token,
	project,
	session,
	setting,
	workspace,
} from "./schema.ts";

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SALVAGE_TABLES = [
	"node",
	"project",
	"workspace",
	"session",
	"document",
	"one_time_token",
	"device",
	"setting",
] as const;

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

export type CatalogListRow = CatalogRow & { project_name: string | null; node_name: string | null };

export interface WorkspaceBinding {
	projectId: Protocol.ProjectId;
	projectName: string;
	workspaceId: Protocol.WorkspaceId;
	nodeId: Protocol.NodeId;
	rootPath: string;
	gitRemote: string | null;
	createdAt: string;
}

export interface ExportRows {
	project: { id: Protocol.ProjectId; name: string; created_at: string };
	nodes: Array<{ id: Protocol.NodeId; name: string; created_at: string }>;
	workspaces: Array<typeof workspace.$inferSelect>;
	sessions: CatalogRow[];
	documents: Protocol.Document[];
}

export interface ImportCounts {
	created: boolean;
	workspaces: { created: number; reused: number };
	documents: { imported: number; skipped: number };
	sessions: { imported: number; skipped: number; unreadable: number; missing: number };
}

export interface ImportedLog {
	sessionId: Protocol.SessionId;
	path: string;
	recover: boolean;
}

export class WorkspaceConflictError extends Error {
	readonly rootPath: string;
	readonly projectId: Protocol.ProjectId;
	readonly projectName: string;

	constructor(rootPath: string, projectId: Protocol.ProjectId, projectName: string) {
		super(`${rootPath} already belongs to project ${projectName}`);
		this.rootPath = rootPath;
		this.projectId = projectId;
		this.projectName = projectName;
	}
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
		if (!passesIntegrityCheck(opened.client)) {
			opened.client.close();
			return new Catalog(rebuildDatabase(path, "the catalog database failed its integrity check"));
		}
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

	upsertNode(identity: { id: Protocol.NodeId; name: string; createdAt: string }): void {
		this.#db
			.insert(node)
			.values({ id: identity.id, name: identity.name, created_at: identity.createdAt, enrolled_at: identity.createdAt })
			.onConflictDoUpdate({
				target: node.id,
				set: { name: identity.name, enrolled_at: identity.createdAt, revoked_at: null },
			})
			.run();
	}

	createOneTimeToken(kind: "node" | "device"): { token: string; expiresAt: string } {
		const token = randomBytes(32).toString("hex");
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
		this.#db
			.insert(one_time_token)
			.values({
				id: randomUUID(),
				token_hash: hashSecret(token),
				created_at: now.toISOString(),
				expires_at: expiresAt,
				kind,
			})
			.run();
		return { token, expiresAt };
	}

	consumeOneTimeToken(kind: "node" | "device", token: string): "ok" | "expired" | "used" | "invalid" {
		return this.#db.transaction(
			(tx) => {
				const row = tx
					.select()
					.from(one_time_token)
					.where(eq(one_time_token.token_hash, hashSecret(token)))
					.get();
				if (!row || row.kind !== kind) return "invalid";
				if (row.used_at !== null) return "used";
				const now = new Date().toISOString();
				if (row.expires_at <= now) return "expired";
				tx.update(one_time_token).set({ used_at: now }).where(eq(one_time_token.id, row.id)).run();
				return "ok";
			},
			{ behavior: "immediate" },
		);
	}

	createDevice(name: string, tokenHash: string): typeof device.$inferSelect {
		return this.#db
			.insert(device)
			.values({
				id: randomUUID(),
				name,
				token_hash: tokenHash,
				created_at: new Date().toISOString(),
			})
			.returning()
			.get();
	}

	findDeviceByTokenHash(hash: string): typeof device.$inferSelect | undefined {
		return this.#db.select().from(device).where(eq(device.token_hash, hash)).get();
	}

	touchDevice(id: Protocol.DeviceId, at: string): void {
		this.#db.update(device).set({ last_seen_at: at }).where(eq(device.id, id)).run();
	}

	listDevices(): Array<typeof device.$inferSelect> {
		return this.#db.select().from(device).orderBy(asc(device.created_at)).all();
	}

	deleteDevice(id: Protocol.DeviceId): typeof device.$inferSelect | undefined {
		return this.#db.delete(device).where(eq(device.id, id)).returning().get();
	}

	getSetting(key: string): string | undefined {
		return this.#db.select().from(setting).where(eq(setting.key, key)).get()?.value;
	}

	setSetting(key: string, value: string): void {
		this.#db.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } }).run();
	}

	deleteSetting(key: string): void {
		this.#db.delete(setting).where(eq(setting.key, key)).run();
	}

	enrollNode(identity: { id: Protocol.NodeId; name: string; createdAt: string }, secretHash: string): void {
		const now = new Date().toISOString();
		this.#db
			.insert(node)
			.values({
				id: identity.id,
				name: identity.name,
				created_at: identity.createdAt,
				secret_hash: secretHash,
				enrolled_at: now,
				revoked_at: null,
				last_seen_at: now,
			})
			.onConflictDoUpdate({
				target: node.id,
				set: {
					name: identity.name,
					secret_hash: secretHash,
					enrolled_at: now,
					revoked_at: null,
					last_seen_at: now,
				},
			})
			.run();
	}

	verifyNodeSecret(id: Protocol.NodeId, secret: string): "ok" | "missing" | "revoked" | "invalid" {
		const row = this.#db.select().from(node).where(eq(node.id, id)).get();
		if (!row || row.secret_hash === null) return row ? "invalid" : "missing";
		if (row.revoked_at !== null) return "revoked";
		const actual = Buffer.from(hashSecret(secret), "hex");
		const expected = Buffer.from(row.secret_hash, "hex");
		return actual.length === expected.length && timingSafeEqual(actual, expected) ? "ok" : "invalid";
	}

	revokeNode(id: Protocol.NodeId): typeof node.$inferSelect | undefined {
		return this.#db.update(node).set({ revoked_at: new Date().toISOString() }).where(eq(node.id, id)).returning().get();
	}

	touchNode(id: Protocol.NodeId, lastSeenAt = new Date().toISOString()): void {
		this.#db.update(node).set({ last_seen_at: lastSeenAt }).where(eq(node.id, id)).run();
	}

	listNodes(): Array<typeof node.$inferSelect> {
		return this.#db.select().from(node).orderBy(asc(node.created_at)).all();
	}

	nodeExists(id: Protocol.NodeId): boolean {
		return this.#db.select({ id: node.id }).from(node).where(eq(node.id, id)).get() !== undefined;
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
				createdAt: workspace.created_at,
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
				createdAt: workspace.created_at,
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
					createdAt: now,
				};
			});
		} catch (error) {
			const existing = this.findWorkspaceByRoot(input.nodeId, input.rootPath);
			if (existing) return existing;
			throw error;
		}
	}

	listWorkspaces(projectId: Protocol.ProjectId): WorkspaceBinding[] {
		return this.projectWorkspaces(projectId);
	}

	getWorkspace(workspaceId: Protocol.WorkspaceId): WorkspaceBinding | undefined {
		return this.#db
			.select({
				projectId: project.id,
				projectName: project.name,
				workspaceId: workspace.id,
				nodeId: workspace.node_id,
				rootPath: workspace.root_path,
				gitRemote: workspace.git_remote,
				createdAt: workspace.created_at,
			})
			.from(workspace)
			.innerJoin(project, eq(workspace.project_id, project.id))
			.where(eq(workspace.id, workspaceId))
			.get();
	}

	addWorkspace(
		projectId: Protocol.ProjectId,
		input: { nodeId: Protocol.NodeId; rootPath: string; gitRemote: string | null },
	): { binding: WorkspaceBinding; created: boolean } {
		const insert = () => {
			const createdAt = new Date().toISOString();
			const row = {
				id: randomUUID(),
				project_id: projectId,
				node_id: input.nodeId,
				root_path: input.rootPath,
				git_remote: input.gitRemote,
				created_at: createdAt,
			};
			this.#db.insert(workspace).values(row).run();
			const projectRow = this.#db.select({ name: project.name }).from(project).where(eq(project.id, projectId)).get();
			if (!projectRow) throw new Error(`Project ${projectId} does not exist`);
			return {
				binding: {
					projectId,
					projectName: projectRow.name,
					workspaceId: row.id,
					nodeId: input.nodeId,
					rootPath: input.rootPath,
					gitRemote: input.gitRemote,
					createdAt,
				},
				created: true,
			};
		};
		const existing = this.findWorkspaceByRoot(input.nodeId, input.rootPath);
		if (existing?.projectId === projectId) return { binding: existing, created: false };
		if (existing) throw new WorkspaceConflictError(input.rootPath, existing.projectId, existing.projectName);
		try {
			return insert();
		} catch (error) {
			const raced = this.findWorkspaceByRoot(input.nodeId, input.rootPath);
			if (raced?.projectId === projectId) return { binding: raced, created: false };
			if (raced) throw new WorkspaceConflictError(input.rootPath, raced.projectId, raced.projectName);
			throw error;
		}
	}

	// Startup reconciliation refreshes log-derived fields without deleting logical entities.
	reconcile(scan: CatalogScan): void {
		this.#db.transaction((tx) => {
			const bindingsByRoot = new Map<string, WorkspaceBinding>();
			const bindingsByKey = new Map<string, WorkspaceBinding>();
			const bindingsById = new Map<Protocol.WorkspaceId, WorkspaceBinding>();
			const existingBindings = tx
				.select({
					projectId: project.id,
					projectName: project.name,
					workspaceId: workspace.id,
					nodeId: workspace.node_id,
					rootPath: workspace.root_path,
					gitRemote: workspace.git_remote,
					createdAt: workspace.created_at,
				})
				.from(workspace)
				.innerJoin(project, eq(workspace.project_id, project.id))
				.all();
			for (const binding of existingBindings) {
				bindingsByRoot.set(`${binding.nodeId}\0${binding.rootPath}`, binding);
				bindingsByKey.set(`${binding.nodeId}\0${Protocol.projectKey(binding.rootPath)}`, binding);
				bindingsById.set(binding.workspaceId, binding);
			}

			const scannedIds = new Set<Protocol.SessionId>();
			for (const entry of scan.sessions) {
				const descriptor = entry.session;
				scannedIds.add(descriptor.id);
				const existingRow = tx.select().from(session).where(eq(session.id, descriptor.id)).get();
				const existingBinding = existingRow?.workspace_id ? bindingsById.get(existingRow.workspace_id) : undefined;
				const nodeId = existingBinding?.nodeId ?? descriptor.nodeId;
				tx.insert(node)
					.values({ id: nodeId, name: nodeId, created_at: descriptor.createdAt })
					.onConflictDoNothing()
					.run();
				const existing = existingBinding ?? bindingsByRoot.get(`${nodeId}\0${descriptor.projectRoot}`);
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
							createdAt: now,
						};
					})();
				bindingsByRoot.set(`${binding.nodeId}\0${binding.rootPath}`, binding);
				bindingsByKey.set(`${binding.nodeId}\0${entry.projectKey}`, binding);
				bindingsById.set(binding.workspaceId, binding);
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
				const existingRow = tx.select().from(session).where(eq(session.id, entry.id)).get();
				const binding = existingRow?.node_id
					? bindingsByKey.get(`${existingRow.node_id}\0${entry.projectKey}`)
					: undefined;
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
		const key = Protocol.projectKey(descriptor.projectRoot);
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

	busySessions(nodeId: Protocol.NodeId): Protocol.SessionId[] {
		return this.#db
			.select({ id: session.id })
			.from(session)
			.where(and(eq(session.node_id, nodeId), eq(session.status, "busy")))
			.all()
			.map((row) => row.id);
	}

	list(scope?: { nodeId: Protocol.NodeId; rootPath: string } | { projectId: Protocol.ProjectId }): CatalogListRow[] {
		const selection = { ...getTableColumns(session), project_name: project.name, node_name: node.name };
		if (!scope) {
			return this.#db
				.select(selection)
				.from(session)
				.leftJoin(project, eq(session.project_id, project.id))
				.leftJoin(node, eq(session.node_id, node.id))
				.orderBy(asc(session.created_at))
				.all();
		}
		if ("projectId" in scope) {
			return this.#db
				.select(selection)
				.from(session)
				.leftJoin(project, eq(session.project_id, project.id))
				.leftJoin(node, eq(session.node_id, node.id))
				.where(eq(session.project_id, scope.projectId))
				.orderBy(asc(session.created_at))
				.all();
		}
		const binding = this.findWorkspaceByRoot(scope.nodeId, scope.rootPath);
		const unreadableMatch = and(
			eq(session.status, "unreadable"),
			eq(session.project_key, Protocol.projectKey(scope.rootPath)),
		);
		return this.#db
			.select(selection)
			.from(session)
			.leftJoin(project, eq(session.project_id, project.id))
			.leftJoin(node, eq(session.node_id, node.id))
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

	getProject(id: Protocol.ProjectId): Protocol.Project | undefined {
		const row = this.#db
			.select({
				id: project.id,
				name: project.name,
				created_at: project.created_at,
				session_count: count(session.id),
				last_activity_at: max(session.updated_at),
			})
			.from(project)
			.leftJoin(session, eq(session.project_id, project.id))
			.where(eq(project.id, id))
			.groupBy(project.id)
			.get();
		if (!row) return undefined;
		return {
			id: row.id,
			name: row.name,
			createdAt: row.created_at,
			sessionCount: row.session_count,
			lastActivityAt: row.last_activity_at,
		};
	}

	exportRows(projectId: Protocol.ProjectId): ExportRows | undefined {
		const projectRow = this.#db.select().from(project).where(eq(project.id, projectId)).get();
		if (!projectRow) return undefined;
		const workspaces = this.#db.select().from(workspace).where(eq(workspace.project_id, projectId)).all();
		const nodeIds = [...new Set(workspaces.map((item) => item.node_id))];
		return {
			project: projectRow,
			nodes: nodeIds.length === 0 ? [] : this.#db.select().from(node).where(inArray(node.id, nodeIds)).all(),
			workspaces,
			sessions: this.#db
				.select()
				.from(session)
				.where(eq(session.project_id, projectId))
				.orderBy(asc(session.created_at))
				.all(),
			documents: this.#db
				.select()
				.from(document)
				.where(eq(document.project_id, projectId))
				.orderBy(asc(document.created_at))
				.all()
				.map(toDocument),
		};
	}

	importRows(
		manifest: Protocol.ArchiveManifest,
		explicitNodeId: Protocol.NodeId | undefined,
		bodies: Map<string, string>,
		logs: Map<Protocol.SessionId, string>,
		logExists: (projectKey: string, sessionId: Protocol.SessionId) => string | undefined,
		placeLog: (
			sessionId: Protocol.SessionId,
			projectKey: string,
			stagedPath: string,
		) => { placed: true; path: string } | { placed: false },
	): { counts: ImportCounts; logs: ImportedLog[] } {
		const enrolled = this.listNodes().filter((item) => item.enrolled_at !== null && item.revoked_at === null);
		const soleNodeId = enrolled.length === 1 ? enrolled[0]?.id : undefined;
		const enrolledIds = new Set(enrolled.map((item) => item.id));
		const archiveNodes = new Map(manifest.nodes.map((item) => [item.id, item]));
		const bindNode = (archiveNodeId: Protocol.NodeId | null): Protocol.NodeId => {
			if (explicitNodeId !== undefined) return explicitNodeId;
			if (archiveNodeId !== null && enrolledIds.has(archiveNodeId)) return archiveNodeId;
			if (soleNodeId !== undefined) return soleNodeId;
			return archiveNodeId ?? `placeholder-${manifest.project.id}`;
		};
		return this.#db.transaction((tx) => {
			const moved: string[] = [];
			try {
				const created =
					Number(
						tx
							.insert(project)
							.values({
								id: manifest.project.id,
								name: manifest.project.name,
								created_at: manifest.project.createdAt,
							})
							.onConflictDoNothing()
							.run().changes,
					) === 1;
				const workspaceIds = new Map<string, string>();
				const workspaceNodeIds = new Map<string, Protocol.NodeId>();
				let workspacesCreated = 0;
				let workspacesReused = 0;
				for (const item of manifest.workspaces) {
					const nodeId = bindNode(item.nodeId);
					const archiveNode = archiveNodes.get(item.nodeId);
					tx.insert(node)
						.values({
							id: nodeId,
							name: archiveNode?.name ?? nodeId,
							created_at: archiveNode?.createdAt ?? item.createdAt,
						})
						.onConflictDoNothing()
						.run();
					const existing = tx
						.select({
							id: workspace.id,
							projectId: workspace.project_id,
							projectName: project.name,
						})
						.from(workspace)
						.innerJoin(project, eq(workspace.project_id, project.id))
						.where(and(eq(workspace.node_id, nodeId), eq(workspace.root_path, item.rootPath)))
						.get();
					if (existing && existing.projectId !== manifest.project.id) {
						throw new WorkspaceConflictError(item.rootPath, existing.projectId, existing.projectName);
					}
					if (existing) {
						workspaceIds.set(item.id, existing.id);
						workspaceNodeIds.set(item.id, nodeId);
						workspacesReused++;
						continue;
					}
					tx.insert(workspace)
						.values({
							id: item.id,
							project_id: manifest.project.id,
							node_id: nodeId,
							root_path: item.rootPath,
							git_remote: item.gitRemote,
							created_at: item.createdAt,
						})
						.run();
					workspaceIds.set(item.id, item.id);
					workspaceNodeIds.set(item.id, nodeId);
					workspacesCreated++;
				}

				let documentsImported = 0;
				let documentsSkipped = 0;
				for (const item of manifest.documents) {
					const body = bodies.get(item.file);
					if (body === undefined) throw new Error(`Document body ${item.file} is missing`);
					const changes = Number(
						tx
							.insert(document)
							.values({
								id: item.id,
								project_id: manifest.project.id,
								title: item.title,
								body,
								created_at: item.createdAt,
								updated_at: item.updatedAt,
							})
							.onConflictDoNothing()
							.run().changes,
					);
					if (changes === 1) documentsImported++;
					if (changes !== 1) documentsSkipped++;
				}

				let sessionsImported = 0;
				let sessionsSkipped = 0;
				let sessionsUnreadable = 0;
				let sessionsMissing = 0;
				const importedLogs: ImportedLog[] = [];
				for (const item of manifest.sessions) {
					const staged = logs.get(item.id);
					const existingLog = logExists(item.projectKey, item.id);
					if (!staged && !existingLog) {
						sessionsMissing++;
						continue;
					}
					const nodeId =
						item.workspaceId === null
							? bindNode(item.nodeId)
							: (workspaceNodeIds.get(item.workspaceId) ?? bindNode(item.nodeId));
					if (!tx.select({ id: node.id }).from(node).where(eq(node.id, nodeId)).get()) {
						const archiveNode = item.nodeId === null ? undefined : archiveNodes.get(item.nodeId);
						tx.insert(node)
							.values({
								id: nodeId,
								name: archiveNode?.name ?? nodeId,
								created_at: archiveNode?.createdAt ?? item.createdAt ?? manifest.exportedAt,
							})
							.onConflictDoNothing()
							.run();
					}
					const changes = Number(
						tx
							.insert(session)
							.values({
								id: item.id,
								project_key: item.projectKey,
								cwd: item.cwd,
								title: item.title,
								status: item.status,
								error: item.error,
								created_at: item.createdAt,
								updated_at: item.updatedAt,
								project_id: manifest.project.id,
								workspace_id: item.workspaceId === null ? null : (workspaceIds.get(item.workspaceId) ?? null),
								node_id: nodeId,
							})
							.onConflictDoNothing()
							.run().changes,
					);
					if (changes !== 1) {
						sessionsSkipped++;
						continue;
					}
					sessionsImported++;
					if (item.status === "unreadable") sessionsUnreadable++;
					const placed = staged ? placeLog(item.id, item.projectKey, staged) : { placed: false as const };
					if (placed.placed) moved.push(placed.path);
					const path = placed.placed ? placed.path : existingLog;
					if (path) importedLogs.push({ sessionId: item.id, path, recover: item.status === "busy" });
				}
				return {
					counts: {
						created,
						workspaces: { created: workspacesCreated, reused: workspacesReused },
						documents: { imported: documentsImported, skipped: documentsSkipped },
						sessions: {
							imported: sessionsImported,
							skipped: sessionsSkipped,
							unreadable: sessionsUnreadable,
							missing: sessionsMissing,
						},
					},
					logs: importedLogs,
				};
			} catch (error) {
				for (const path of moved) rmSync(path, { force: true });
				throw error;
			}
		});
	}

	listDocuments(projectId: Protocol.ProjectId): Protocol.DocumentSummary[] {
		return this.#db
			.select({
				id: document.id,
				title: document.title,
				createdAt: document.created_at,
				updatedAt: document.updated_at,
			})
			.from(document)
			.where(eq(document.project_id, projectId))
			.orderBy(desc(document.updated_at))
			.all();
	}

	createDocument(projectId: Protocol.ProjectId, input: Protocol.DocumentRequest): Protocol.Document {
		const now = new Date().toISOString();
		const row = this.#db
			.insert(document)
			.values({
				id: randomUUID(),
				project_id: projectId,
				title: input.title,
				body: input.body,
				created_at: now,
				updated_at: now,
			})
			.returning()
			.get();
		return toDocument(row);
	}

	getDocument(id: Protocol.DocumentId): Protocol.Document | undefined {
		const row = this.#db.select().from(document).where(eq(document.id, id)).get();
		return row ? toDocument(row) : undefined;
	}

	updateDocument(id: Protocol.DocumentId, input: Protocol.DocumentRequest): Protocol.Document | undefined {
		const row = this.#db
			.update(document)
			.set({ title: input.title, body: input.body, updated_at: new Date().toISOString() })
			.where(eq(document.id, id))
			.returning()
			.get();
		return row ? toDocument(row) : undefined;
	}

	deleteDocument(id: Protocol.DocumentId): Protocol.Document | undefined {
		const row = this.#db.delete(document).where(eq(document.id, id)).returning().get();
		return row ? toDocument(row) : undefined;
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

export function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

function openDatabase(path: string): { client: DatabaseSync; version: number } {
	const client = new DatabaseSync(path);
	try {
		chmodSync(path, 0o600);
		client.exec("PRAGMA busy_timeout = 5000");
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

// Checks every database page so corruption in an already-current catalog is detected before queries run.
function passesIntegrityCheck(client: DatabaseSync): boolean {
	try {
		const rows = client.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
		return rows.length === 1 && rows[0]?.quick_check === "ok";
	} catch (error) {
		if (isCorruptDatabase(error)) return false;
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
	salvageRows(preservedPath, client);
	return client;
}

// Copies readable rows table by table; damaged pages stop only their table and invalid rows are skipped.
function salvageRows(preservedPath: string, client: DatabaseSync): void {
	const source = (() => {
		try {
			return new DatabaseSync(preservedPath);
		} catch (error) {
			console.error(`ker: could not open ${preservedPath} for salvage: ${describeError(error)}`);
			return undefined;
		}
	})();
	if (!source) return;
	try {
		client.exec("BEGIN");
		for (const table of SALVAGE_TABLES) {
			let copied = 0;
			let skipped = 0;
			try {
				const sourceColumns = new Set(
					(source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
				);
				const columns = (client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
					.map((column) => column.name)
					.filter((column) => sourceColumns.has(column));
				if (columns.length === 0) continue;
				const insert = client.prepare(
					`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				);
				for (const row of source.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).iterate()) {
					try {
						const result = insert.run(...columns.map((column) => row[column]));
						if (Number(result.changes) === 1) copied++;
						if (Number(result.changes) !== 1) skipped++;
					} catch {
						skipped++;
					}
				}
			} catch (error) {
				console.error(`ker: salvage of ${table} stopped: ${describeError(error)}`);
			}
			console.error(
				`ker: salvaged ${copied} ${table} rows from ${preservedPath}${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
			);
		}
		client.exec("COMMIT");
	} catch (error) {
		try {
			client.exec("ROLLBACK");
		} catch {}
		console.error(`ker: salvage aborted: ${describeError(error)}`);
	} finally {
		try {
			source.close();
		} catch (error) {
			console.error(`ker: could not close ${preservedPath} after salvage: ${describeError(error)}`);
		}
	}
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

function toDocument(row: typeof document.$inferSelect): Protocol.Document {
	return {
		id: row.id,
		projectId: row.project_id,
		title: row.title,
		body: row.body,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
