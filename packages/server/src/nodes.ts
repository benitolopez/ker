import { randomUUID } from "node:crypto";
import type * as Protocol from "@ker-ai/protocol";
import type { NodeCallMethod, PlaneToNodeFrame } from "@ker-ai/protocol/node";

export interface NodeHandle {
	readonly id: Protocol.NodeId;
	createSession(cwd: string): Promise<Protocol.SessionDescriptor>;
	admit(sessionId: Protocol.SessionId, text: string): Promise<Protocol.PromptAdmission | "context_exhausted">;
	compact(sessionId: Protocol.SessionId, instructions?: string): Promise<Protocol.CompactionAdmission>;
	cancel(
		sessionId: Protocol.SessionId,
		turnId: Protocol.TurnId,
	): Promise<Protocol.TurnCancellationResult | "turn_unavailable">;
	recover(sessionIds: Protocol.SessionId[], imported?: boolean): Promise<void>;
	resolveProjectRoot(cwd: string): Promise<string>;
	observeGitRemote(root: string): Promise<string | null>;
	folderExists(path: string): Promise<boolean>;
}

export class NodeRegistry {
	readonly #handles = new Map<Protocol.NodeId, NodeHandle>();
	readonly #listeners = new Set<(id: Protocol.NodeId, connected: boolean) => void>();

	register(handle: NodeHandle): void {
		this.#handles.set(handle.id, handle);
		for (const listener of this.#listeners) listener(handle.id, true);
	}

	unregister(id: Protocol.NodeId): void {
		if (!this.#handles.delete(id)) return;
		for (const listener of this.#listeners) listener(id, false);
	}

	get(id: Protocol.NodeId): NodeHandle | undefined {
		return this.#handles.get(id);
	}

	connected(): NodeHandle[] {
		return [...this.#handles.values()];
	}

	onChange(listener: (id: Protocol.NodeId, connected: boolean) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

export class NodeUnavailableError extends Error {
	readonly nodeId?: Protocol.NodeId;

	constructor(nodeId?: Protocol.NodeId) {
		super(nodeId ? `Node ${nodeId} is unavailable` : "No node is connected");
		this.nodeId = nodeId;
	}
}

export class NodeAmbiguousError extends Error {}

export class NodeNotFoundError extends Error {}

export class RemoteNode implements NodeHandle {
	readonly id: Protocol.NodeId;
	readonly #send: (frame: PlaneToNodeFrame) => void;
	readonly #disconnectConnection: () => void;
	readonly #pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout?: NodeJS.Timeout }
	>();
	#closed = false;

	constructor(id: Protocol.NodeId, send: (frame: PlaneToNodeFrame) => void, disconnect: () => void) {
		this.id = id;
		this.#send = send;
		this.#disconnectConnection = disconnect;
	}

	createSession(cwd: string): Promise<Protocol.SessionDescriptor> {
		return this.#call("createSession", [cwd]) as Promise<Protocol.SessionDescriptor>;
	}

	admit(sessionId: string, text: string): Promise<Protocol.PromptAdmission | "context_exhausted"> {
		return this.#call("admit", [sessionId, text]) as Promise<Protocol.PromptAdmission | "context_exhausted">;
	}

	compact(sessionId: string, instructions?: string): Promise<Protocol.CompactionAdmission> {
		return this.#call(
			"compact",
			instructions === undefined ? [sessionId] : [sessionId, instructions],
		) as Promise<Protocol.CompactionAdmission>;
	}

	cancel(sessionId: string, turnId: string): Promise<Protocol.TurnCancellationResult | "turn_unavailable"> {
		return this.#call("cancel", [sessionId, turnId]) as Promise<Protocol.TurnCancellationResult | "turn_unavailable">;
	}

	async recover(sessionIds: string[], imported = false): Promise<void> {
		await this.#call("recover", [sessionIds, imported], false);
	}

	resolveProjectRoot(cwd: string): Promise<string> {
		return this.#call("resolveProjectRoot", [cwd]) as Promise<string>;
	}

	observeGitRemote(root: string): Promise<string | null> {
		return this.#call("observeGitRemote", [root]) as Promise<string | null>;
	}

	folderExists(path: string): Promise<boolean> {
		return this.#call("folderExists", [path]) as Promise<boolean>;
	}

	resolve(id: string, value: unknown): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		if (pending.timeout) clearTimeout(pending.timeout);
		this.#pending.delete(id);
		pending.resolve(value);
	}

	reject(id: string, code: string, message: string): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		if (pending.timeout) clearTimeout(pending.timeout);
		this.#pending.delete(id);
		pending.reject(new RemoteCallError(code, message));
	}

	close(): void {
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			if (pending.timeout) clearTimeout(pending.timeout);
			pending.reject(new NodeUnavailableError(this.id));
		}
		this.#pending.clear();
	}

	disconnect(): void {
		this.#disconnectConnection();
		this.close();
	}

	#call(method: NodeCallMethod, args: unknown[], timed = true): Promise<unknown> {
		if (this.#closed) return Promise.reject(new NodeUnavailableError(this.id));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = timed
				? setTimeout(() => {
						this.#pending.delete(id);
						reject(new NodeUnavailableError(this.id));
					}, 30_000)
				: undefined;
			timeout?.unref();
			this.#pending.set(id, { resolve, reject, timeout });
			this.#send({ type: "call", id, method, args });
		});
	}
}

export class RemoteCallError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}
