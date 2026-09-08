import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { SessionStore, STORE_VERSION, type StoredRecord } from "@ker-ai/store";
import type { NodeHandle } from "../src/nodes.ts";
import { NodeAmbiguousError, NodeRegistry, NodeUnavailableError } from "../src/nodes.ts";
import { ControlPlane } from "../src/plane.ts";

const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ID = "00000000-0000-4000-8000-000000000002";

test("routes node-bound work across two nodes and keeps offline projects readable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-plane-nodes-"));
	const nodes = new NodeRegistry();
	const plane = new ControlPlane({
		store: new SessionStore({ baseDir: join(root, "sessions") }),
		catalogPath: join(root, "catalog.db"),
		eventTailSize: 100,
		nodes,
	});
	await plane.initialize();
	t.after(async () => {
		await plane.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	const first = new FakeNode(FIRST_ID, new Set(["/work/first"]));
	const second = new FakeNode(SECOND_ID, new Set(["/work/second"]));
	plane.enrollNode({ id: first.id, name: "Laptop", createdAt: first.createdAt }, "first-secret");
	plane.enrollNode({ id: second.id, name: "Desktop", createdAt: second.createdAt }, "second-secret");
	nodes.register(first);
	nodes.register(second);

	await assert.rejects(plane.createSession("/work/first"), NodeAmbiguousError);
	const created = await plane.createSession("/work/first", first.id);
	assert.equal(created.nodeId, first.id);
	const forgedHeader: StoredRecord = {
		version: STORE_VERSION,
		recordId: "forged-session",
		previousRecordId: null,
		at: created.createdAt,
		type: "session",
		session: { ...created, nodeId: second.id },
	};
	assert.equal(plane.canCreateSession(second.id, created.id, [forgedHeader]), false);
	const project = plane.listProjects()[0];
	assert(project);
	assert.equal(plane.listSessions()[0]?.nodeName, "Laptop");
	await assert.rejects(plane.addWorkspace(project.id, "/work/second"), NodeAmbiguousError);
	const added = await plane.addWorkspace(project.id, "/work/second", second.id);
	assert.notEqual(added, "missing");
	if (added === "missing") return;
	assert.equal(added.workspace.nodeId, second.id);
	assert.equal(added.workspace.nodeName, "Desktop");
	assert.equal(added.workspace.nodeConnected, true);
	assert.equal(added.workspace.exists, true);
	assert.equal(await plane.createProjectSession(project.id), "ambiguous");
	const workspaceSession = await plane.createWorkspaceSession(added.workspace.id);
	assert.notEqual(workspaceSession, "workspace_missing");
	if (workspaceSession === "workspace_missing") return;
	assert.equal(workspaceSession.nodeId, second.id);

	nodes.unregister(first.id);
	const workspaces = await plane.listWorkspaces(project.id);
	assert.notEqual(workspaces, "missing");
	if (workspaces === "missing") return;
	const offline = workspaces.find((workspace) => workspace.nodeId === first.id);
	assert.equal(offline?.nodeConnected, false);
	assert.equal(offline?.exists, null);
	await assert.rejects(plane.admit(created.id, "hello"), NodeUnavailableError);
	const fallback = await plane.createProjectSession(project.id);
	assert.notEqual(fallback, "workspace_missing");
	assert.notEqual(fallback, "ambiguous");
	assert.notEqual(fallback, "project_missing");
	if (typeof fallback === "string") return;
	assert.equal(fallback.nodeId, second.id);

	const exported = await plane.exportProject(project.id);
	assert.notEqual(exported, "missing");
	if (exported === "missing") return;
	const chunks: Uint8Array[] = [];
	for await (const chunk of exported.stream) chunks.push(chunk);
	assert(chunks.length > 0);
});

test("evicts idle projections while keeping subscribed projections loaded", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-plane-projection-"));
	const store = new SessionStore({ baseDir: join(root, "sessions") });
	const descriptor: Protocol.SessionDescriptor = {
		id: "session-projection",
		nodeId: FIRST_ID,
		cwd: "/work/first",
		projectRoot: "/work/first",
		createdAt: "2026-09-08T00:00:00.000Z",
		updatedAt: "2026-09-08T00:00:00.000Z",
	};
	const log = await store.createLog(descriptor.projectRoot, descriptor.id);
	await log.append([
		{ type: "session", session: descriptor },
		{
			type: "definition",
			systemPrompt: "System prompt",
			tools: [],
			compaction: { systemPrompt: "Summary", initialInstructions: "Initial", updateInstructions: "Update" },
		},
	]);
	const plane = new ControlPlane({
		store,
		catalogPath: join(root, "catalog.db"),
		eventTailSize: 100,
		projectionIdleMs: 20,
	});
	await plane.initialize();
	t.after(async () => {
		await plane.shutdown();
		await rm(root, { recursive: true, force: true });
	});

	const first = await plane.snapshot(descriptor.id);
	assert(first);
	await new Promise<void>((resolve) => setTimeout(resolve, 40));
	const reloaded = await plane.snapshot(descriptor.id);
	assert(reloaded);
	assert.notEqual(reloaded.cursor.epoch, first.cursor.epoch);
	const subscription = await plane.subscribe(descriptor.id, reloaded.cursor, () => undefined);
	assert.notEqual(subscription, "missing");
	assert.notEqual(subscription, "resync");
	await new Promise<void>((resolve) => setTimeout(resolve, 40));
	assert.equal((await plane.snapshot(descriptor.id))?.cursor.epoch, reloaded.cursor.epoch);
	if (typeof subscription !== "string") subscription.unsubscribe();
	await new Promise<void>((resolve) => setTimeout(resolve, 40));
	assert.notEqual((await plane.snapshot(descriptor.id))?.cursor.epoch, reloaded.cursor.epoch);
});

class FakeNode implements NodeHandle {
	readonly createdAt = "2026-09-08T00:00:00.000Z";
	readonly id: Protocol.NodeId;
	readonly #folders: Set<string>;
	#sequence = 0;

	constructor(id: Protocol.NodeId, folders: Set<string>) {
		this.id = id;
		this.#folders = folders;
	}

	async createSession(cwd: string): Promise<Protocol.SessionDescriptor> {
		this.#sequence++;
		return {
			id: `${this.id}-session-${this.#sequence}`,
			nodeId: this.id,
			cwd,
			projectRoot: cwd,
			createdAt: this.createdAt,
			updatedAt: this.createdAt,
		};
	}

	async admit(sessionId: Protocol.SessionId): Promise<Protocol.PromptAdmission> {
		return {
			status: "running",
			sessionId,
			turnId: "turn-1",
			messageId: "message-1",
			queueItemId: "queue-1",
			queue: { revision: 1, waiting: [] },
		};
	}

	async compact(sessionId: Protocol.SessionId): Promise<Protocol.CompactionAdmission> {
		return {
			status: "running",
			sessionId,
			turnId: "turn-compact",
			queueItemId: "queue-compact",
			queue: { revision: 1, waiting: [] },
		};
	}

	async cancel(sessionId: Protocol.SessionId, turnId: Protocol.TurnId): Promise<Protocol.TurnCancellationResult> {
		return { status: "cancelled", sessionId, turnId };
	}

	async recover(): Promise<void> {}

	async resolveProjectRoot(cwd: string): Promise<string> {
		return cwd;
	}

	async observeGitRemote(): Promise<null> {
		return null;
	}

	async folderExists(path: string): Promise<boolean> {
		return this.#folders.has(path);
	}
}
