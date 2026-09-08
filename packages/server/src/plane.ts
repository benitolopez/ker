import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import type * as Protocol from "@ker-ai/protocol";
import { PROTOCOL_VERSION } from "@ker-ai/protocol";
import type { Payload, StoredRecord, StoredSession } from "@ker-ai/store";
import { type SessionStore, STORE_VERSION } from "@ker-ai/store";
import { archiveFileName, buildManifest, InvalidArchiveError, readArchive, writeArchive } from "./archive.ts";
import { Catalog, type CatalogListRow, type CatalogRow, hashSecret, type WorkspaceBinding } from "./catalog.ts";
import {
	NodeAmbiguousError,
	type NodeHandle,
	NodeNotFoundError,
	NodeRegistry,
	NodeUnavailableError,
	RemoteCallError,
} from "./nodes.ts";
import { SessionProjection } from "./projection.ts";
import { CATALOG_VERSION } from "./schema.ts";

const PROJECTION_IDLE_MS = 10 * 60_000;

export interface ControlPlaneOptions {
	store: SessionStore;
	catalogPath: string;
	eventTailSize: number;
	projectionIdleMs?: number;
	nodes?: NodeRegistry;
	localIdentity?: { id: Protocol.NodeId; name: string; createdAt: string };
}

export interface Subscription {
	replay: Protocol.EventEnvelope[];
	unsubscribe: () => void;
}

export class SessionUnreadableError extends Error {
	readonly sessionId: Protocol.SessionId;

	constructor(sessionId: Protocol.SessionId, message: string) {
		super(message);
		this.sessionId = sessionId;
	}
}

export class WorkspaceNotFoundError extends Error {}

export class ControlPlane {
	readonly nodes: NodeRegistry;
	readonly #store: SessionStore;
	readonly #catalogPath: string;
	readonly #eventTailSize: number;
	readonly #projectionIdleMs: number;
	readonly #localIdentity?: { id: Protocol.NodeId; name: string; createdAt: string };
	readonly #paths = new Map<Protocol.SessionId, string>();
	readonly #sessionNodeIds = new Map<Protocol.SessionId, Protocol.NodeId>();
	readonly #stored = new Map<Protocol.SessionId, Promise<StoredSession>>();
	readonly #projections = new Map<Protocol.SessionId, Promise<SessionProjection>>();
	readonly #projectionSubscribers = new Map<Protocol.SessionId, number>();
	readonly #projectionEvictions = new Map<Protocol.SessionId, NodeJS.Timeout>();
	#catalog!: Catalog;

	constructor(options: ControlPlaneOptions) {
		this.#store = options.store;
		this.#catalogPath = options.catalogPath;
		this.#eventTailSize = options.eventTailSize;
		this.#projectionIdleMs = options.projectionIdleMs ?? PROJECTION_IDLE_MS;
		this.#localIdentity = options.localIdentity;
		this.nodes = options.nodes ?? new NodeRegistry();
	}

	async initialize(): Promise<void> {
		this.#catalog = Catalog.open(this.#catalogPath);
		if (this.#localIdentity) this.#catalog.upsertNode(this.#localIdentity);
		const scan = await this.#store.scanCatalog();
		for (const entry of scan.sessions) {
			this.#paths.set(entry.session.id, entry.path);
			this.#sessionNodeIds.set(entry.session.id, entry.session.nodeId);
		}
		for (const entry of scan.unreadable) {
			this.#paths.set(entry.id, this.#store.logPath(entry.projectKey, entry.id));
		}
		this.#catalog.reconcile(scan);
		await Promise.all(this.nodes.connected().map((node) => this.recoverNode(node)));
	}

	async loadRecords(sessionId: Protocol.SessionId): Promise<StoredRecord[]> {
		return [...(await this.#loadStored(sessionId)).records];
	}

	async appendPayloads(sessionId: Protocol.SessionId, payloads: Payload[]): Promise<StoredRecord[]> {
		const stored = await this.#storedForAppend(sessionId, payloads);
		const records = await stored.log.append(payloads);
		stored.records.push(...records);
		const updatedAt = records.at(-1)?.at;
		if (updatedAt) stored.session.updatedAt = updatedAt;
		await this.#applyRecords(sessionId, records);
		return records;
	}

	async appendRecords(
		sessionId: Protocol.SessionId,
		records: StoredRecord[],
	): Promise<{ written: StoredRecord[]; skipped: StoredRecord[] }> {
		const payloads = records.map(
			({ version: _version, recordId: _id, previousRecordId: _previous, at: _at, ...payload }) => payload as Payload,
		);
		const stored = await this.#storedForAppend(sessionId, payloads);
		try {
			const result = await stored.log.appendRecords(records);
			stored.records.push(...result.written);
			const updatedAt = result.written.at(-1)?.at;
			if (updatedAt) stored.session.updatedAt = updatedAt;
			await this.#applyRecords(sessionId, result.written);
			return result;
		} catch (error) {
			this.#markUnreadable(sessionId, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	async publishDelta(sessionId: Protocol.SessionId, event: Protocol.TurnEvent): Promise<void> {
		const projection = await this.#projection(sessionId);
		projection.applyDelta(event);
	}

	async createSession(cwd: string, nodeId?: Protocol.NodeId): Promise<Protocol.SessionDescriptor> {
		const node = this.#pickNode(nodeId);
		const descriptor = await node.createSession(cwd);
		const root = descriptor.projectRoot;
		const existing = this.#catalog.findWorkspaceByRoot(node.id, root);
		const binding =
			existing ??
			this.#catalog.createWorkspace({
				nodeId: node.id,
				rootPath: root,
				projectName: basename(root) || root,
				gitRemote: await node.observeGitRemote(root),
			});
		this.#catalog.upsertCreated(descriptor, binding);
		return descriptor;
	}

	async createProjectSession(
		projectId: Protocol.ProjectId,
	): Promise<Protocol.ReadableCatalogSession | "project_missing" | "workspace_missing" | "ambiguous"> {
		if (!this.#catalog.projectExists(projectId)) return "project_missing";
		const workspaces = this.#catalog.projectWorkspaces(projectId);
		if (workspaces.length > 0 && workspaces.every((workspace) => !this.nodes.get(workspace.nodeId))) {
			throw new NodeUnavailableError(workspaces[0]?.nodeId);
		}
		const candidates = await Promise.all(
			workspaces.map(async (workspace) => {
				const node = this.nodes.get(workspace.nodeId);
				return { workspace, node, exists: node ? await node.folderExists(workspace.rootPath) : false };
			}),
		);
		const available = candidates.filter(
			(candidate): candidate is typeof candidate & { node: NodeHandle } =>
				candidate.node !== undefined && candidate.exists,
		);
		if (available.length === 0) return "workspace_missing";
		if (available.length > 1) return "ambiguous";
		return this.#createInWorkspace(available[0].workspace, available[0].node);
	}

	async createWorkspaceSession(
		workspaceId: Protocol.WorkspaceId,
	): Promise<Protocol.ReadableCatalogSession | "workspace_missing"> {
		const binding = this.#catalog.getWorkspace(workspaceId);
		if (!binding) throw new WorkspaceNotFoundError();
		const node = this.nodes.get(binding.nodeId);
		if (!node) throw new NodeUnavailableError(binding.nodeId);
		if (!(await node.folderExists(binding.rootPath))) return "workspace_missing";
		return this.#createInWorkspace(binding, node);
	}

	listSessions(scope?: { projectRoot: string; nodeId: Protocol.NodeId }): Protocol.CatalogSession[] {
		return this.#catalog
			.list(scope ? { nodeId: scope.nodeId, rootPath: scope.projectRoot } : undefined)
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
				path: this.#store.logPath(item.project_key, item.id),
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

	async importProject(source: AsyncIterable<Uint8Array>, nodeId?: Protocol.NodeId): Promise<Protocol.ImportResult> {
		if (nodeId !== undefined && !this.#catalog.nodeExists(nodeId)) throw new NodeNotFoundError();
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
				nodeId,
				bodies,
				logs,
				(projectKey, sessionId) => {
					const path = this.#store.logPath(projectKey, sessionId);
					return existsSync(path) ? path : undefined;
				},
				(sessionId, projectKey, stagedPath) => this.#store.placeLog(stagedPath, projectKey, sessionId),
			);
			for (const log of imported.logs) {
				this.#paths.set(log.sessionId, log.path);
				this.#stored.delete(log.sessionId);
				this.#projections.delete(log.sessionId);
				const eviction = this.#projectionEvictions.get(log.sessionId);
				if (eviction) clearTimeout(eviction);
				this.#projectionEvictions.delete(log.sessionId);
				const row = this.#catalog.get(log.sessionId);
				if (row?.node_id) this.#sessionNodeIds.set(log.sessionId, row.node_id);
			}
			for (const log of imported.logs) {
				if (!log.recover) continue;
				const row = this.#catalog.get(log.sessionId);
				const node = row?.node_id ? this.nodes.get(row.node_id) : undefined;
				if (!node) continue;
				try {
					await node.recover([log.sessionId], true);
				} catch (error) {
					if (!isSessionFailure(error)) throw error;
					this.#markUnreadable(log.sessionId, error.message);
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
		const names = new Map(this.#catalog.listNodes().map((node) => [node.id, node.name]));
		return Promise.all(
			this.#catalog.listWorkspaces(projectId).map(async (binding) => {
				const node = this.nodes.get(binding.nodeId);
				return {
					id: binding.workspaceId,
					projectId: binding.projectId,
					nodeId: binding.nodeId,
					nodeName: names.get(binding.nodeId) ?? binding.nodeId,
					nodeConnected: node !== undefined,
					rootPath: binding.rootPath,
					gitRemote: binding.gitRemote,
					createdAt: binding.createdAt,
					exists: node ? await node.folderExists(binding.rootPath) : null,
				};
			}),
		);
	}

	async addWorkspace(
		projectId: Protocol.ProjectId,
		path: string,
		nodeId?: Protocol.NodeId,
	): Promise<"missing" | { workspace: Protocol.Workspace; created: boolean }> {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		const node = this.#pickNode(nodeId);
		const rootPath = await node.resolveProjectRoot(path);
		const result = this.#catalog.addWorkspace(projectId, {
			nodeId: node.id,
			rootPath,
			gitRemote: await node.observeGitRemote(rootPath),
		});
		const nodeName = this.#catalog.listNodes().find((item) => item.id === node.id)?.name ?? node.id;
		return {
			created: result.created,
			workspace: {
				id: result.binding.workspaceId,
				projectId: result.binding.projectId,
				nodeId: result.binding.nodeId,
				nodeName,
				nodeConnected: true,
				rootPath: result.binding.rootPath,
				gitRemote: result.binding.gitRemote,
				createdAt: result.binding.createdAt,
				exists: await node.folderExists(result.binding.rootPath),
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

	async resolveProjectRoot(
		cwd: string,
		nodeId?: Protocol.NodeId,
	): Promise<{ projectRoot: string; nodeId: Protocol.NodeId }> {
		const node = this.#pickNode(nodeId);
		return { projectRoot: await node.resolveProjectRoot(cwd), nodeId: node.id };
	}

	unreadableSession(sessionId: Protocol.SessionId): CatalogRow | undefined {
		const row = this.#catalog.get(sessionId);
		return row?.status === "unreadable" ? row : undefined;
	}

	async snapshot(sessionId: Protocol.SessionId): Promise<Protocol.SessionSnapshot | undefined> {
		const row = this.#catalog.get(sessionId);
		if (!row) return undefined;
		if (row.status === "unreadable") {
			throw new SessionUnreadableError(sessionId, row.error ?? "Session log is unreadable");
		}
		return (await this.#projection(sessionId)).snapshot();
	}

	async subscribe(
		sessionId: Protocol.SessionId,
		cursor: Protocol.Cursor,
		listener: (envelope: Protocol.EventEnvelope) => void,
	): Promise<Subscription | "missing" | "resync"> {
		const row = this.#catalog.get(sessionId);
		if (!row) return "missing";
		if (row.status === "unreadable") {
			throw new SessionUnreadableError(sessionId, row.error ?? "Session log is unreadable");
		}
		const subscription = (await this.#projection(sessionId)).subscribe(cursor, listener);
		if (subscription === "resync") return subscription;
		const eviction = this.#projectionEvictions.get(sessionId);
		if (eviction) clearTimeout(eviction);
		this.#projectionEvictions.delete(sessionId);
		this.#projectionSubscribers.set(sessionId, (this.#projectionSubscribers.get(sessionId) ?? 0) + 1);
		const active = { value: true };
		return {
			replay: subscription.replay,
			unsubscribe: () => {
				if (!active.value) return;
				active.value = false;
				subscription.unsubscribe();
				const remaining = (this.#projectionSubscribers.get(sessionId) ?? 1) - 1;
				if (remaining > 0) {
					this.#projectionSubscribers.set(sessionId, remaining);
					return;
				}
				this.#projectionSubscribers.delete(sessionId);
				this.#scheduleProjectionEviction(sessionId);
			},
		};
	}

	async admit(
		sessionId: Protocol.SessionId,
		text: string,
	): Promise<Protocol.PromptAdmission | "missing" | "context_exhausted"> {
		return this.#route(sessionId, (node) => node.admit(sessionId, text));
	}

	compactNow(sessionId: Protocol.SessionId, instructions?: string): Promise<Protocol.CompactionAdmission | "missing"> {
		return this.#route(sessionId, (node) => node.compact(sessionId, instructions));
	}

	cancel(
		sessionId: Protocol.SessionId,
		turnId: Protocol.TurnId,
	): Promise<Protocol.TurnCancellationResult | "missing" | "turn_unavailable"> {
		return this.#route(sessionId, (node) => node.cancel(sessionId, turnId));
	}

	listNodes(): Protocol.Node[] {
		return this.#catalog.listNodes().map((node) => ({
			id: node.id,
			name: node.name,
			createdAt: node.created_at,
			enrolledAt: node.enrolled_at,
			revokedAt: node.revoked_at,
			lastSeenAt: node.last_seen_at,
			connected: this.nodes.get(node.id) !== undefined,
		}));
	}

	nodeUnavailableMessage(nodeId: Protocol.NodeId): string {
		const name = this.#catalog.listNodes().find((node) => node.id === nodeId)?.name ?? nodeId;
		return `${name} is offline`;
	}

	createEnrollment(origin: string): Protocol.Enrollment {
		const enrollment = this.#catalog.createEnrollmentToken();
		return { ...enrollment, command: `ker node --server ${origin} --token ${enrollment.token}` };
	}

	revokeNode(nodeId: Protocol.NodeId): Protocol.Node | undefined {
		const row = this.#catalog.revokeNode(nodeId);
		if (!row) return undefined;
		const handle = this.nodes.get(nodeId);
		if (handle && "disconnect" in handle && typeof handle.disconnect === "function") handle.disconnect();
		this.nodes.unregister(nodeId);
		return {
			id: row.id,
			name: row.name,
			createdAt: row.created_at,
			enrolledAt: row.enrolled_at,
			revokedAt: row.revoked_at,
			lastSeenAt: row.last_seen_at,
			connected: false,
		};
	}

	consumeEnrollmentToken(token: string): "ok" | "expired" | "used" | "invalid" {
		return this.#catalog.consumeEnrollmentToken(token);
	}

	enrollNode(identity: { id: string; name: string; createdAt: string }, secret: string): void {
		this.#catalog.enrollNode(identity, hashSecret(secret));
	}

	verifyNodeSecret(id: Protocol.NodeId, secret: string): "ok" | "missing" | "revoked" | "invalid" {
		return this.#catalog.verifyNodeSecret(id, secret);
	}

	touchNode(id: Protocol.NodeId): void {
		this.#catalog.touchNode(id);
	}

	readySessions(nodeId: Protocol.NodeId, running: Protocol.SessionId[]): Protocol.SessionId[] {
		const active = new Set(running);
		return this.#catalog.busySessions(nodeId).filter((sessionId) => !active.has(sessionId));
	}

	ownsSession(nodeId: Protocol.NodeId, sessionId: Protocol.SessionId): boolean {
		const owner = this.#sessionNodeIds.get(sessionId);
		if (owner) return owner === nodeId;
		const catalogOwner = this.#catalog.get(sessionId)?.node_id ?? undefined;
		if (catalogOwner) this.#sessionNodeIds.set(sessionId, catalogOwner);
		return catalogOwner === nodeId;
	}

	nodeIdForSession(sessionId: Protocol.SessionId): Protocol.NodeId | undefined {
		return this.#sessionNodeIds.get(sessionId) ?? this.#catalog.get(sessionId)?.node_id ?? undefined;
	}

	hasSession(sessionId: Protocol.SessionId): boolean {
		return this.#stored.has(sessionId) || this.#paths.has(sessionId) || this.nodeIdForSession(sessionId) !== undefined;
	}

	canCreateSession(nodeId: Protocol.NodeId, sessionId: Protocol.SessionId, records: StoredRecord[]): boolean {
		if (this.hasSession(sessionId)) return false;
		const first = records[0];
		return first?.type === "session" && first.session.nodeId === nodeId && first.session.id === sessionId;
	}

	markUnreadable(sessionId: Protocol.SessionId, reason: string): void {
		this.#markUnreadable(sessionId, reason);
	}

	async shutdown(): Promise<void> {
		for (const eviction of this.#projectionEvictions.values()) clearTimeout(eviction);
		this.#projectionEvictions.clear();
		this.#catalog.close();
	}

	async recoverNode(node: NodeHandle): Promise<void> {
		try {
			await node.recover(this.#catalog.busySessions(node.id));
		} catch (error) {
			if (!(error instanceof AggregateError)) throw error;
			for (const failure of error.errors as unknown[]) {
				if (isSessionFailure(failure)) this.#markUnreadable(failure.sessionId, failure.message);
			}
			if ((error.errors as unknown[]).some((failure) => !isSessionFailure(failure))) throw error;
		}
	}

	async #createInWorkspace(binding: WorkspaceBinding, node: NodeHandle): Promise<Protocol.ReadableCatalogSession> {
		const descriptor = await node.createSession(binding.rootPath);
		this.#catalog.upsertCreated(descriptor, binding);
		const nodeName = this.#catalog.listNodes().find((item) => item.id === binding.nodeId)?.name ?? binding.nodeId;
		return {
			status: "idle",
			id: descriptor.id,
			cwd: descriptor.cwd,
			projectId: binding.projectId,
			projectName: binding.projectName,
			workspaceId: binding.workspaceId,
			nodeId: binding.nodeId,
			nodeName,
			title: null,
			createdAt: descriptor.createdAt,
			updatedAt: descriptor.updatedAt,
		};
	}

	#pickNode(nodeId?: Protocol.NodeId): NodeHandle {
		if (nodeId !== undefined) {
			const handle = this.nodes.get(nodeId);
			if (handle) return handle;
			if (this.#catalog.nodeExists(nodeId)) throw new NodeUnavailableError(nodeId);
			throw new NodeNotFoundError();
		}
		const connected = this.nodes.connected();
		if (connected.length === 1 && connected[0]) return connected[0];
		if (connected.length === 0) throw new NodeUnavailableError();
		throw new NodeAmbiguousError();
	}

	async #route<T>(sessionId: Protocol.SessionId, operation: (node: NodeHandle) => Promise<T>): Promise<T | "missing"> {
		const row = this.#catalog.get(sessionId);
		if (!row) return "missing";
		if (row.status === "unreadable") {
			throw new SessionUnreadableError(sessionId, row.error ?? "Session log is unreadable");
		}
		if (!row.node_id) throw new NodeUnavailableError();
		const node = this.nodes.get(row.node_id);
		if (!node) throw new NodeUnavailableError(row.node_id);
		try {
			return await operation(node);
		} catch (error) {
			if (error instanceof RemoteCallError && error.code === "unknown_session") {
				this.#markUnreadable(sessionId, error.message);
				throw new SessionUnreadableError(sessionId, error.message);
			}
			if (!isSessionFailure(error)) throw error;
			this.#markUnreadable(sessionId, error.message);
			throw new SessionUnreadableError(sessionId, error.message);
		}
	}

	#loadStored(sessionId: Protocol.SessionId): Promise<StoredSession> {
		const existing = this.#stored.get(sessionId);
		if (existing) return existing;
		const path = this.#paths.get(sessionId);
		if (!path) return Promise.reject(new Error(`Unknown session ${sessionId}`));
		const loading = this.#store.loadSession(path);
		this.#stored.set(sessionId, loading);
		return loading.catch((error: unknown) => {
			this.#stored.delete(sessionId);
			throw error;
		});
	}

	async #storedForAppend(sessionId: Protocol.SessionId, payloads: Payload[]): Promise<StoredSession> {
		const existing = this.#stored.get(sessionId);
		if (existing) return existing;
		const path = this.#paths.get(sessionId);
		if (path) return this.#loadStored(sessionId);
		const first = payloads[0];
		if (!first || first.type !== "session" || first.session.id !== sessionId) {
			throw new Error(`Unknown session ${sessionId}`);
		}
		const creating = (async () => {
			const log = await this.#store.createLog(first.session.projectRoot, sessionId);
			this.#paths.set(sessionId, log.path);
			this.#sessionNodeIds.set(sessionId, first.session.nodeId);
			return { log, records: [], session: { ...first.session } };
		})();
		this.#stored.set(sessionId, creating);
		return creating;
	}

	async #projection(sessionId: Protocol.SessionId): Promise<SessionProjection> {
		const existing = this.#projections.get(sessionId);
		if (existing) return existing;
		const loading = this.#loadStored(sessionId).then((stored) => {
			const projection = SessionProjection.load(stored.records, this.#eventTailSize);
			const firstUserText = projection.firstUserText();
			if (firstUserText !== undefined) this.#catalog.setTitleIfEmpty(sessionId, truncate(firstUserText));
			this.#scheduleProjectionEviction(sessionId);
			return projection;
		});
		this.#projections.set(sessionId, loading);
		return loading.catch((error: unknown) => {
			this.#projections.delete(sessionId);
			const message = error instanceof Error ? error.message : String(error);
			this.#markUnreadable(sessionId, message);
			throw new SessionUnreadableError(sessionId, message);
		});
	}

	async #applyRecords(sessionId: Protocol.SessionId, records: StoredRecord[]): Promise<void> {
		if (records.length === 0) return;
		const existing = this.#projections.get(sessionId);
		const projection = await this.#projection(sessionId);
		if (existing) projection.apply(records);
		this.#scheduleProjectionEviction(sessionId);
		try {
			this.#catalog.touch(sessionId, {
				updatedAt: records.at(-1)?.at ?? new Date().toISOString(),
				status: projection.status(),
			});
			const firstUserText = projection.firstUserText();
			if (firstUserText !== undefined) this.#catalog.setTitleIfEmpty(sessionId, truncate(firstUserText));
		} catch (error) {
			console.error(`catalog update failed for session ${sessionId}:`, error);
		}
	}

	#scheduleProjectionEviction(sessionId: Protocol.SessionId): void {
		const existing = this.#projectionEvictions.get(sessionId);
		if (existing) clearTimeout(existing);
		this.#projectionEvictions.delete(sessionId);
		if ((this.#projectionSubscribers.get(sessionId) ?? 0) > 0) return;
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		const eviction = setTimeout(() => {
			if (this.#projections.get(sessionId) !== projection) return;
			if ((this.#projectionSubscribers.get(sessionId) ?? 0) > 0) return;
			this.#projections.delete(sessionId);
			this.#projectionEvictions.delete(sessionId);
		}, this.#projectionIdleMs);
		eviction.unref();
		this.#projectionEvictions.set(sessionId, eviction);
	}

	#markUnreadable(sessionId: Protocol.SessionId, message: string): void {
		try {
			this.#catalog.markUnreadable(sessionId, message);
		} catch (error) {
			console.error(`catalog update failed for session ${sessionId}:`, error);
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
			...(row.node_name === null ? {} : { nodeName: row.node_name }),
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
		row.node_name === null ||
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
		nodeName: row.node_name,
		title: row.title,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function isSessionFailure(error: unknown): error is Error & { sessionId: Protocol.SessionId } {
	return (
		error instanceof Error && "sessionId" in error && typeof (error as { sessionId?: unknown }).sessionId === "string"
	);
}

function truncate(text: string): string {
	return text.trim().split("\n")[0].slice(0, 80).trim();
}
