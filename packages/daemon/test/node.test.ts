import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { InvalidCwdError, Node, type SessionChange, SessionUnreadableError, UnknownSessionError } from "../src/node.ts";
import { type Definition, SessionStore } from "../src/store.ts";

const DEFINITION: Definition = {
	systemPrompt: "System prompt",
	tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
	compaction: {
		systemPrompt: "Summary system prompt",
		initialInstructions: "Initial summary instructions",
		updateInstructions: "Update summary instructions",
	},
};

test("reports append activity without leaking catalog state into the node", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-changes-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const changes: SessionChange[] = [];
	const node = createNode(root, new SessionStore({ baseDir: join(root, "sessions") }), (change) => {
		changes.push(change);
	});
	const session = await node.createSession(root);
	const admission = await node.admit(session.id, "first prompt");
	assert.notEqual(admission, "context_exhausted");
	if (admission === "context_exhausted") throw new Error("Expected prompt admission");
	await waitForTerminal(node, session.id, admission.turnId);

	assert(changes.some((change) => change.status === "busy"));
	assert.equal(changes.at(-1)?.status, "idle");
	assert(changes.every((change) => change.sessionId === session.id));
	assert(changes.every((change) => change.firstUserText === undefined));
	assert(changes.every((change) => !Number.isNaN(Date.parse(change.updatedAt))));
	await node.shutdown();
});

test("reports the first stored prompt once when a session is first loaded", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-first-prompt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: join(root, "sessions") });
	const stored = await store.create(root, DEFINITION);
	await stored.log.append([
		{
			type: "event",
			event: {
				actor: "human",
				sessionId: stored.session.id,
				turnId: "turn-1",
				type: "message_submitted",
				messageId: "message-1",
				queueItemId: "queue-1",
				text: "stored prompt\nignored",
				admission: "running",
			},
		},
	]);
	const changes: SessionChange[] = [];
	const node = createNode(root, store, (change) => {
		changes.push(change);
	});
	await node.scan();

	await node.snapshot(stored.session.id);
	assert.equal(changes.length, 1);
	assert.equal(changes[0]?.firstUserText, "stored prompt\nignored");
	await node.snapshot(stored.session.id);
	assert.equal(changes.length, 1);
	await node.shutdown();
});

test("owns project-root resolution and rejects invalid cwd values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-cwd-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repository = join(root, "repository");
	const nested = join(repository, "nested");
	const brokenRepository = join(root, "broken-repository");
	const brokenNested = join(brokenRepository, "nested");
	const plain = join(root, "plain");
	const file = join(root, "file");
	await Promise.all([
		mkdir(join(repository, ".git"), { recursive: true }),
		mkdir(nested, { recursive: true }),
		mkdir(brokenNested, { recursive: true }),
		mkdir(plain, { recursive: true }),
		writeFile(file, "not a directory"),
	]);
	await symlink(".git", join(brokenRepository, ".git"));
	const node = createNode(root, new SessionStore({ baseDir: join(root, "sessions") }));

	assert.equal(await node.resolveProjectRoot(nested), await realpath(repository));
	assert.equal(await node.resolveProjectRoot(plain), await realpath(plain));
	for (const cwd of ["relative", join(root, "missing"), file, brokenNested]) {
		await assert.rejects(node.resolveProjectRoot(cwd), InvalidCwdError);
	}
	await node.shutdown();
});

test("keeps scan paths private and distinguishes unknown from unreadable sessions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-errors-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore({ baseDir: join(root, "sessions") });
	const stored = await store.create(root, DEFINITION);
	const contents = await readFile(stored.log.path, "utf8");
	await writeFile(stored.log.path, `${contents}not-json\n`);
	const node = createNode(root, store);
	const scan = await node.scan();

	assert.equal("path" in (scan.sessions[0] ?? {}), false);
	await assert.rejects(node.snapshot("unknown"), UnknownSessionError);
	await assert.rejects(node.snapshot(stored.session.id), SessionUnreadableError);
	await assert.rejects(node.snapshot(stored.session.id), SessionUnreadableError);
	await node.shutdown();
});

function createNode(
	root: string,
	store: SessionStore,
	onSessionChange: (change: SessionChange) => void = () => undefined,
): Node {
	return new Node({
		store,
		nodePath: join(root, "node.json"),
		harnessFactory: immediateFactory,
		definition: () => structuredClone(DEFINITION),
		eventTailSize: 100,
		recoveryWindowMinutes: Number.MAX_SAFE_INTEGER,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
		onSessionChange,
	});
}

function immediateFactory(initial: Engine.HarnessState) {
	const state = structuredClone(initial);
	return {
		snapshot: () => structuredClone(state),
		async *compact(): AsyncGenerator<Protocol.TurnEvent, Engine.CompactionOutcome> {
			yield* [];
			return { kind: "skipped" as const, reason: "nothing_to_compact" as const };
		},
		async *send(input: Engine.UserMessage) {
			state.messages.push({ role: "user", content: input.text });
			yield {
				actor: "human" as const,
				modelRole: "user" as const,
				sessionId: input.sessionId,
				turnId: input.turnId,
				type: "message_delivered" as const,
				messageId: input.messageId,
				text: input.text,
			};
			const messageId = "assistant-1";
			yield {
				actor: "agent" as const,
				modelRole: "assistant" as const,
				sessionId: input.sessionId,
				turnId: input.turnId,
				type: "message_delta" as const,
				messageId,
				offset: 0,
				text: "answer",
			};
			state.messages.push({ role: "assistant", content: "answer", toolCalls: [], reasoning: [] });
			yield {
				actor: "agent" as const,
				modelRole: "assistant" as const,
				sessionId: input.sessionId,
				turnId: input.turnId,
				type: "assistant_message_completed" as const,
				messageId,
				reason: "completed" as const,
			};
			yield {
				actor: "process" as const,
				sessionId: input.sessionId,
				turnId: input.turnId,
				type: "end" as const,
			};
		},
	};
}

async function waitForTerminal(node: Node, sessionId: Protocol.SessionId, turnId: Protocol.TurnId): Promise<void> {
	while (true) {
		const snapshot = await node.snapshot(sessionId);
		const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
		if (turn && turn.status !== "running" && turn.status !== "cancelling" && turn.status !== "waiting") return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
