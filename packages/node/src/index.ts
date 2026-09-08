import * as Agent from "@ker-ai/agent";
import * as Config from "@ker-ai/config";
import type * as Protocol from "@ker-ai/protocol";
import type { Definition } from "@ker-ai/store";
import { defaultNodePath, loadNodeIdentity, type NodeIdentity } from "./identity.ts";
import { Link } from "./link.ts";
import { createConfiguredHarness, Node, type NodeOptions, type NodePlane } from "./node.ts";

export { defaultNodePath, loadNodeIdentity, type NodeIdentity, saveNodeServer } from "./identity.ts";
export { Link, LinkRefusedError } from "./link.ts";
export {
	createConfiguredHarness,
	type Harness,
	InvalidCwdError,
	Node,
	type NodeOptions,
	type NodePlane,
	SessionUnreadableError,
} from "./node.ts";
export { canonicalDirectory, canonicalProjectRoot, observeGitRemote } from "./paths.ts";
export { Spool } from "./spool.ts";

export interface CreateNodeOptions {
	plane: NodePlane;
	identity?: { id: Protocol.NodeId; name: string; createdAt: string };
	nodePath?: string;
	harnessFactory?: NodeOptions["harnessFactory"];
	definition?: NodeOptions["definition"];
	recoveryWindowMinutes?: number;
	compaction?: NodeOptions["compaction"];
}

export interface RunNodeOptions extends Omit<CreateNodeOptions, "plane" | "identity"> {
	serverUrl?: string;
	token?: string;
	spoolDir?: string;
	onStatus?: (message: string) => void;
}

export interface RunningNode {
	readonly node: Node;
	readonly link: Link;
	shutdown(): Promise<void>;
}

export function createNode(options: CreateNodeOptions): Node {
	const config = Config.loadConfig();
	const identity = options.identity ?? loadNodeIdentity(options.nodePath ?? defaultNodePath());
	return new Node({
		plane: options.plane,
		identity,
		harnessFactory: options.harnessFactory ?? ((state, cwd) => createConfiguredHarness(state, cwd, config)),
		definition: options.definition ?? createDefinition,
		recoveryWindowMinutes: options.recoveryWindowMinutes ?? config.recoveryWindowMinutes,
		compaction: options.compaction ?? config.compaction,
	});
}

export async function runNode(options: RunNodeOptions = {}): Promise<RunningNode> {
	const identityPath = options.nodePath ?? defaultNodePath();
	const identity: NodeIdentity = loadNodeIdentity(identityPath);
	const serverUrl = options.serverUrl ?? identity.server?.url;
	if (!serverUrl) throw new Error("No server is configured; pass --server and --token to enroll this node");
	if (!options.token && !identity.server?.secret) {
		throw new Error("No node credential is configured; pass --token to enroll this node");
	}
	const link = new Link({
		serverUrl,
		token: options.token,
		identity,
		identityPath,
		spoolDir: options.spoolDir,
		onStatus: options.onStatus,
	});
	const node = createNode({ ...options, plane: link, identity });
	link.attach(node);
	await link.start();
	return {
		node,
		link,
		shutdown: () => link.shutdown(),
	};
}

function createDefinition(cwd: string): Definition {
	const definition = Agent.createDefinition(cwd);
	return {
		systemPrompt: definition.systemPrompt,
		tools: definition.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
		compaction: definition.compaction,
	};
}
