import {
	createNode,
	defaultNodePath,
	loadNodeIdentity,
	type Node,
	type NodeOptions,
	type NodePlane,
} from "@ker-ai/node";
import type * as Protocol from "@ker-ai/protocol";
import { createServer, type KerServer, type NodeHandle, NodeRegistry } from "@ker-ai/server";
import type { Payload, StoredRecord } from "@ker-ai/store";

export type { Harness } from "@ker-ai/node";

export interface DaemonOptions {
	harnessFactory?: NodeOptions["harnessFactory"];
	definition?: NodeOptions["definition"];
	sessionDir?: string;
	catalogPath?: string;
	nodePath?: string;
	eventTailSize?: number;
	recoveryWindowMinutes?: number;
	compaction?: NodeOptions["compaction"];
	guiDir?: string;
}

export type Daemon = KerServer;

export function createDaemon(options: DaemonOptions = {}): Daemon {
	const identity = loadNodeIdentity(options.nodePath ?? defaultNodePath());
	const nodes = new NodeRegistry();
	const server = createServer({
		sessionDir: options.sessionDir,
		catalogPath: options.catalogPath,
		eventTailSize: options.eventTailSize,
		guiDir: options.guiDir,
		nodes,
		localIdentity: identity,
	});
	const node = createNode({
		plane: new LocalPlane(server),
		identity,
		harnessFactory: options.harnessFactory,
		definition: options.definition,
		recoveryWindowMinutes: options.recoveryWindowMinutes,
		compaction: options.compaction,
	});
	nodes.register(new LocalNode(node));
	const shutdownServer = server.shutdown.bind(server);
	server.shutdown = async () => {
		await node.shutdown();
		await shutdownServer();
	};
	return server;
}

class LocalPlane implements NodePlane {
	readonly #server: KerServer;

	constructor(server: KerServer) {
		this.#server = server;
	}

	load(sessionId: Protocol.SessionId): Promise<StoredRecord[]> {
		return this.#server.plane.loadRecords(sessionId);
	}

	append(sessionId: Protocol.SessionId, payloads: Payload[]): Promise<StoredRecord[]> {
		return this.#server.plane.appendPayloads(sessionId, payloads);
	}

	publish(sessionId: Protocol.SessionId, event: Protocol.TurnEvent): void {
		void this.#server.plane.publishDelta(sessionId, event);
	}
}

class LocalNode implements NodeHandle {
	readonly #node: Node;
	readonly id: Protocol.NodeId;

	constructor(node: Node) {
		this.#node = node;
		this.id = node.identity.id;
	}

	createSession(cwd: string): Promise<Protocol.SessionDescriptor> {
		return this.#node.createSession(cwd);
	}

	admit(sessionId: Protocol.SessionId, text: string): Promise<Protocol.PromptAdmission | "context_exhausted"> {
		return this.#node.admit(sessionId, text);
	}

	compact(sessionId: Protocol.SessionId, instructions?: string): Promise<Protocol.CompactionAdmission> {
		return this.#node.compact(sessionId, instructions);
	}

	cancel(
		sessionId: Protocol.SessionId,
		turnId: Protocol.TurnId,
	): Promise<Protocol.TurnCancellationResult | "turn_unavailable"> {
		return this.#node.cancel(sessionId, turnId);
	}

	recover(sessionIds: Protocol.SessionId[], imported = false): Promise<void> {
		return this.#node.recover(sessionIds, imported);
	}

	resolveProjectRoot(cwd: string): Promise<string> {
		return this.#node.resolveProjectRoot(cwd);
	}

	observeGitRemote(root: string): Promise<string | null> {
		return this.#node.observeGitRemote(root);
	}

	folderExists(path: string): Promise<boolean> {
		return this.#node.folderExists(path);
	}
}
