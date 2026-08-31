import { basename } from "node:path";
import type * as Protocol from "@ker-ai/protocol";
import { Catalog, type CatalogListRow, type CatalogRow } from "./catalog.ts";
import { type Node, type SessionChange, SessionUnreadableError } from "./node.ts";

export interface ControlPlaneOptions {
	node: Node;
	catalogPath: string;
}

export interface Subscription {
	replay: Protocol.EventEnvelope[];
	unsubscribe: () => void;
}

export class ControlPlane {
	readonly #node: Node;
	readonly #catalogPath: string;
	#catalog!: Catalog;

	constructor(options: ControlPlaneOptions) {
		this.#node = options.node;
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
	): Promise<Protocol.ReadableCatalogSession | "missing" | "ambiguous"> {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		const workspaces = this.#catalog.projectWorkspaces(projectId);
		if (workspaces.length !== 1) return "ambiguous";
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

	listProjectSessions(projectId: Protocol.ProjectId): Protocol.CatalogSession[] | "missing" {
		if (!this.#catalog.projectExists(projectId)) return "missing";
		return this.#catalog.list({ projectId }).map(toCatalogSession);
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
