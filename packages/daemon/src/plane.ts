import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import { archiveFileName, buildManifest, InvalidArchiveError, readArchive, writeArchive } from "./archive.ts";
import { Catalog, type CatalogListRow, type CatalogRow } from "./catalog.ts";
import { type Node, type SessionChange, SessionUnreadableError } from "./node.ts";
import { CATALOG_VERSION } from "./schema.ts";
import { type SessionStore, STORE_VERSION } from "./store.ts";

export interface ControlPlaneOptions {
	node: Node;
	store: SessionStore;
	catalogPath: string;
}

export interface Subscription {
	replay: Protocol.EventEnvelope[];
	unsubscribe: () => void;
}

export class ControlPlane {
	readonly #node: Node;
	readonly #store: SessionStore;
	readonly #catalogPath: string;
	#catalog!: Catalog;

	constructor(options: ControlPlaneOptions) {
		this.#node = options.node;
		this.#store = options.store;
		this.#catalogPath = options.catalogPath;
	}

	async initialize(): Promise<void> {
		this.#catalog = Catalog.open(this.#catalogPath);
		this.#catalog.upsertNode(this.#node.identity);
		const scan = await this.#node.scan();
		this.#catalog.reconcile(scan, this.#node.identity.id);
		await this.#recoverNode();
	}

	applySessionChange(change: SessionChange): void {
		try {
			this.#catalog.touch(change.sessionId, { updatedAt: change.updatedAt, status: change.status });
			if (change.firstUserText !== undefined) {
				this.#catalog.setTitleIfEmpty(change.sessionId, truncate(change.firstUserText));
			}
		} catch (error) {
			console.error(`catalog update failed for session ${change.sessionId}:`, error);
		}
	}

	async createSession(cwd: string): Promise<Protocol.SessionDescriptor> {
		const descriptor = await this.#node.createSession(cwd);
		const root = descriptor.projectRoot;
		const existing = this.#catalog.findWorkspaceByRoot(this.#node.identity.id, root);
		const binding =
			existing ??
			this.#catalog.createWorkspace({
				nodeId: this.#node.identity.id,
				rootPath: root,
				projectName: basename(root) || root,
				gitRemote: await this.#node.observeGitRemote(root),
			});
		this.#catalog.upsertCreated(descriptor, binding);
		return descriptor;
	}

	async createProjectSession(
		projectId: Protocol.ProjectId,
	): Promise<Protocol.ReadableCatalogSession | "project_missing" | "workspace_missing" | "ambiguous"> {
		if (!this.#catalog.projectExists(projectId)) return "project_missing";
		const candidates = this.#catalog
			.projectWorkspaces(projectId)
			.filter((workspace) => workspace.nodeId === this.#node.identity.id);
		const workspaces = (
			await Promise.all(
				candidates.map(async (workspace) => ({ workspace, exists: await this.#node.folderExists(workspace.rootPath) })),
			)
		)
			.filter((candidate) => candidate.exists)
			.map((candidate) => candidate.workspace);
		if (workspaces.length === 0) return "workspace_missing";
		if (workspaces.length > 1) return "ambiguous";
		const binding = workspaces[0];
		const descriptor = await this.#node.createSession(binding.rootPath);
		this.#catalog.upsertCreated(descriptor, binding);
		return {
			status: "idle",
			id: descriptor.id,
			cwd: descriptor.cwd,
			projectId: binding.projectId,
			projectName: binding.projectName,
			workspaceId: binding.workspaceId,
			nodeId: binding.nodeId,
			title: null,
			createdAt: descriptor.createdAt,
			updatedAt: descriptor.updatedAt,
		};
	}

	listSessions(scope?: { projectRoot: string }): Protocol.CatalogSession[] {
		return this.#catalog
			.list(scope ? { nodeId: this.#node.identity.id, rootPath: scope.projectRoot } : undefined)
			.map(toCatalogSession);
	}

	listProjects(): Protocol.Project[] {
		return this.#catalog.listProjects();
	}

	getProject(projectId: Protocol.ProjectId): Protocol.Project | "missing" {
		return this.#catalog.getProject(projectId) ?? "missing";
	}

	async exportProject(
		projectId: Protocol.ProjectId,
	): Promise<"missing" | { fileName: string; manifest: Protocol.ArchiveManifest; stream: Readable }> {
		const rows = this.#catalog.exportRows(projectId);
		if (!rows) return "missing";
		const exportedAt = new Date().toISOString();
		const archive = await buildManifest({
			exportedAt,
			versions: { protocol: PROTOCOL_VERSION, store: STORE_VERSION, catalog: CATALOG_VERSION },
			project: { id: rows.project.id, name: rows.project.name, createdAt: rows.project.created_at },
			nodes: rows.nodes.map((item) => ({ id: item.id, name: item.name, createdAt: item.created_at })),
			workspaces: rows.workspaces.map((item) => ({
				id: item.id,
				nodeId: item.node_id,
				rootPath: item.root_path,
				gitRemote: item.git_remote,
				createdAt: item.created_at,
			})),
			sessions: rows.sessions.map((item) => ({
				id: item.id,
				projectKey: item.project_key,
				workspaceId: item.workspace_id,
				nodeId: item.node_id,
				cwd: item.cwd,
				title: item.title,
				status: item.status,
				error: item.error,
				createdAt: item.created_at,
				updatedAt: item.updated_at,
				path: this.#node.logPath(item.id),
			})),
			documents: rows.documents,
		});
		const stream = new PassThrough();
		void writeArchive(archive, async (chunk) => {
			if (stream.destroyed) throw new Error("archive stream closed");
			if (!stream.write(chunk)) await once(stream, "drain");
		}).then(
			() => stream.end(),
			(error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))),
		);
		return { fileName: archiveFileName(rows.project.name, exportedAt), manifest: archive.manifest, stream };
	}

	async importProject(source: AsyncIterable<Uint8Array>): Promise<Protocol.ImportResult> {
		const staging = this.#store.stagingDir();
		try {
			const archive = await readArchive(source, staging);
			const bodies = new Map<string, string>();
			for (const document of archive.manifest.documents) {
				const path = archive.files.get(document.file);
				if (!path) throw new InvalidArchiveError(`Archive is missing ${document.file}`);
				try {
					bodies.set(document.file, new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)));
				} catch (error) {
					throw new InvalidArchiveError(error instanceof Error ? error.message : String(error));
				}
			}
			const logs = new Map<Protocol.SessionId, string>();
			for (const session of archive.manifest.sessions) {
				if (!session.file) continue;
				const path = archive.files.get(session.file);
				if (!path) throw new InvalidArchiveError(`Archive is missing ${session.file}`);
				logs.set(session.id, path);
			}
			const imported = this.#catalog.importRows(
				archive.manifest,
				this.#node.identity.id,
				bodies,
				logs,
				(projectKey, sessionId) => {
					const path = this.#store.logPath(projectKey, sessionId);
					return existsSync(path) ? path : undefined;
				},
				(sessionId, projectKey, stagedPath) => this.#store.placeLog(stagedPath, projectKey, sessionId),
			);
			for (const log of imported.logs) {
				try {
					await this.#node.registerSession(log.sessionId, log.path, { recover: log.recover });
				} catch (error) {
					if (!(error instanceof SessionUnreadableError)) throw error;
					this.#markUnreadable(log.sessionId, error);
				}
			}
			const project = this.#catalog.getProject(archive.manifest.project.id);
			if (!project) throw new Error(`Imported project ${archive.manifest.project.id} is missing`);
			return { project, ...imported.counts };
		} finally {
			this.#store.removeStaging(staging);
		}
	}

	async listWorkspaces(projectId: Protocol.ProjectId): Promise<Protocol.Workspace[] | "missing"> {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		return Promise.all(
			this.#catalog.listWorkspaces(projectId).map(async (binding) => ({
				id: binding.workspaceId,
				projectId: binding.projectId,
				nodeId: binding.nodeId,
				rootPath: binding.rootPath,
				gitRemote: binding.gitRemote,
				createdAt: binding.createdAt,
				exists: binding.nodeId === this.#node.identity.id && (await this.#node.folderExists(binding.rootPath)),
			})),
		);
	}

	async addWorkspace(
		projectId: Protocol.ProjectId,
		path: string,
	): Promise<"missing" | { workspace: Protocol.Workspace; created: boolean }> {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		const rootPath = await this.#node.resolveProjectRoot(path);
		const result = this.#catalog.addWorkspace(projectId, {
			nodeId: this.#node.identity.id,
			rootPath,
			gitRemote: await this.#node.observeGitRemote(rootPath),
		});
		return {
			created: result.created,
			workspace: {
				id: result.binding.workspaceId,
				projectId: result.binding.projectId,
				nodeId: result.binding.nodeId,
				rootPath: result.binding.rootPath,
				gitRemote: result.binding.gitRemote,
				createdAt: result.binding.createdAt,
				exists: await this.#node.folderExists(result.binding.rootPath),
			},
		};
	}

	listProjectSessions(projectId: Protocol.ProjectId): Protocol.CatalogSession[] | "missing" {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		return this.#catalog.list({ projectId }).map(toCatalogSession);
	}

	listDocuments(projectId: Protocol.ProjectId): Protocol.DocumentSummary[] | "missing" {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		return this.#catalog.listDocuments(projectId);
	}

	createDocument(projectId: Protocol.ProjectId, input: Protocol.DocumentRequest): Protocol.Document | "missing" {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		return this.#catalog.createDocument(projectId, { ...input, title: input.title.trim() });
	}

	getDocument(documentId: Protocol.DocumentId): Protocol.Document | "missing" {
		return this.#catalog.getDocument(documentId) ?? "missing";
	}

	updateDocument(documentId: Protocol.DocumentId, input: Protocol.DocumentRequest): Protocol.Document | "missing" {
		return this.#catalog.updateDocument(documentId, { ...input, title: input.title.trim() }) ?? "missing";
	}

	deleteDocument(documentId: Protocol.DocumentId): Protocol.Document | "missing" {
		return this.#catalog.deleteDocument(documentId) ?? "missing";
	}

	resolveProjectRoot(cwd: string): Promise<string> {
		return this.#node.resolveProjectRoot(cwd);
	}

	unreadableSession(sessionId: Protocol.SessionId): CatalogRow | undefined {
		const row = this.#catalog.get(sessionId);
		return row?.status === "unreadable" ? row : undefined;
	}

	async snapshot(sessionId: Protocol.SessionId): Promise<Protocol.SessionSnapshot | undefined> {
		const result = await this.#route(sessionId, () => this.#node.snapshot(sessionId));
		return result === "missing" ? undefined : result;
	}

	subscribe(
		sessionId: Protocol.SessionId,
		cursor: Protocol.Cursor,
		listener: (envelope: Protocol.EventEnvelope) => void,
	): Promise<Subscription | "missing" | "resync"> {
		return this.#route(sessionId, () => this.#node.subscribe(sessionId, cursor, listener));
	}

	async admit(
		sessionId: Protocol.SessionId,
		text: string,
	): Promise<Protocol.PromptAdmission | "missing" | "context_exhausted"> {
		const result = await this.#route(sessionId, () => this.#node.admit(sessionId, text));
		if (result === "missing" || result === "context_exhausted") return result;
		try {
			this.#catalog.setTitleIfEmpty(sessionId, truncate(text));
		} catch (error) {
			console.error(`catalog title update failed for session ${sessionId}:`, error);
		}
		return result;
	}

	compactNow(sessionId: Protocol.SessionId, instructions?: string): Promise<Protocol.CompactionAdmission | "missing"> {
		return this.#route(sessionId, () => this.#node.compact(sessionId, instructions));
	}

	cancel(
		sessionId: Protocol.SessionId,
		turnId: Protocol.TurnId,
	): Promise<Protocol.TurnCancellationResult | "missing" | "turn_unavailable"> {
		return this.#route(sessionId, () => this.#node.cancel(sessionId, turnId));
	}

	async shutdown(): Promise<void> {
		try {
			await this.#node.shutdown();
		} finally {
			this.#catalog.close();
		}
	}

	async #route<T>(sessionId: Protocol.SessionId, operation: () => Promise<T>): Promise<T | "missing"> {
		const row = this.#catalog.get(sessionId);
		if (!row) return "missing";
		if (row.status === "unreadable") {
			throw new SessionUnreadableError(sessionId, row.error ?? "Session log is unreadable");
		}
		try {
			return await operation();
		} catch (error) {
			if (!(error instanceof SessionUnreadableError)) throw error;
			this.#markUnreadable(sessionId, error);
			throw error;
		}
	}

	async #recoverNode(): Promise<void> {
		try {
			await this.#node.recover();
		} catch (error) {
			if (!(error instanceof AggregateError)) throw error;
			const failures = error.errors as unknown[];
			for (const failure of failures) {
				if (failure instanceof SessionUnreadableError) this.#markUnreadable(failure.sessionId, failure);
			}
			if (failures.some((failure) => !(failure instanceof SessionUnreadableError))) throw error;
		}
	}

	#markUnreadable(sessionId: Protocol.SessionId, error: SessionUnreadableError): void {
		try {
			this.#catalog.markUnreadable(sessionId, error.message);
		} catch (catalogError) {
			console.error(`catalog update failed for session ${sessionId}:`, catalogError);
		}
	}
}

function toCatalogSession(row: CatalogListRow): Protocol.CatalogSession {
	if (row.status === "unreadable") {
		return {
			status: "unreadable",
			id: row.id,
			error: row.error ?? "Session log is unreadable",
			...(row.cwd === null ? {} : { cwd: row.cwd }),
			...(row.project_id === null ? {} : { projectId: row.project_id }),
			...(row.project_name === null ? {} : { projectName: row.project_name }),
			...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
			...(row.node_id === null ? {} : { nodeId: row.node_id }),
			...(row.title === null ? {} : { title: row.title }),
			...(row.created_at === null ? {} : { createdAt: row.created_at }),
			...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
		};
	}
	if (
		row.cwd === null ||
		row.project_id === null ||
		row.project_name === null ||
		row.workspace_id === null ||
		row.node_id === null ||
		row.created_at === null ||
		row.updated_at === null
	) {
		throw new Error(`Readable catalog row ${row.id} is missing session metadata`);
	}
	return {
		status: row.status,
		id: row.id,
		cwd: row.cwd,
		projectId: row.project_id,
		projectName: row.project_name,
		workspaceId: row.workspace_id,
		nodeId: row.node_id,
		title: row.title,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function truncate(text: string): string {
	return text.trim().split("\n")[0].slice(0, 80).trim();
}
