import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { type Definition, type Payload, SessionLog, type StoredRecord } from "@ker-ai/store";
import { InvalidCwdError, Node, type NodePlane, SessionUnreadableError, UnknownSessionError } from "../src/node.ts";

const DEFINITION: Definition = {
	systemPrompt: "System prompt",
	tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
	compaction: {
		systemPrompt: "Summary system prompt",
		initialInstructions: "Initial summary instructions",
		updateInstructions: "Update summary instructions",
	},
};

test("runs against the plane port and leaves client projection to the plane", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-plane-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const plane = new TestPlane(root);
	const node = createNode(plane);
	const session = await node.createSession(root);
	const admission = await node.admit(session.id, "first prompt");
	assert.notEqual(admission, "context_exhausted");
	if (admission === "context_exhausted") throw new Error("Expected prompt admission");
	await waitForTerminal(plane, session.id, admission.turnId);
	while (node.running().includes(session.id)) await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(session.nodeId, "node-1");
	assert(plane.records(session.id).some((record) => record.type === "conversation"));
	assert(plane.deltas.some((event) => event.type === "message_delta"));
	assert.deepEqual(node.running(), []);
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
	const node = createNode(new TestPlane(root));

	assert.equal(await node.resolveProjectRoot(nested), await realpath(repository));
	assert.equal(await node.resolveProjectRoot(plain), await realpath(plain));
	for (const cwd of ["relative", join(root, "missing"), file, brokenNested]) {
		await assert.rejects(node.resolveProjectRoot(cwd), InvalidCwdError);
	}
	await node.shutdown();
});

test("distinguishes unknown from unreadable plane sessions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-errors-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const plane = new TestPlane(root);
	const node = createNode(plane);
	await assert.rejects(node.admit("unknown", "hello"), UnknownSessionError);
	plane.failures.add("broken");
	await assert.rejects(node.admit("broken", "hello"), SessionUnreadableError);
	await node.shutdown();
});

test("records the reduced context beside a successful compaction", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-node-compaction-stats-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const plane = new TestPlane(root);
	const node = new Node({
		plane,
		identity: { id: "node-1", name: "test-node", createdAt: "2026-01-01T00:00:00.000Z" },
		harnessFactory: (initial) => {
			const harness = immediateFactory(initial);
			return {
				...harness,
				async *compact(input) {
					const usage: Protocol.Usage = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5 };
					yield {
						actor: "process" as const,
						sessionId: input.sessionId,
						turnId: input.turnId,
						type: "usage" as const,
						provider: "openai" as const,
						model: "gpt-5.4-mini",
						usage,
					};
					const kept = harness.snapshot().messages.slice(-1).map(Engine.stripAssistantMetadata);
					return {
						kind: "compacted" as const,
						summary: "summary",
						keptCount: kept.length,
						tokensBefore: 17,
						tokensAfter: 5,
						budgetChars: 400_000,
						reasoningEffort: null,
						messages: [Engine.compactionSummaryMessage("summary"), ...kept],
					};
				},
			};
		},
		definition: () => structuredClone(DEFINITION),
		recoveryWindowMinutes: Number.MAX_SAFE_INTEGER,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	const session = await node.createSession(root);
	const prompt = await node.admit(session.id, "remember this");
	if (prompt === "context_exhausted") throw new Error("Expected prompt admission");
	await waitForTerminal(plane, session.id, prompt.turnId);
	const compacted = await node.compact(session.id);
	await waitForTerminal(plane, session.id, compacted.turnId);

	const batch = plane.appends.find((payloads) => payloads.some((payload) => payload.type === "compaction"));
	assert(batch);
	assert.deepEqual(
		batch.map((payload) => payload.type),
		["compaction", "event", "stats"],
	);
	const stats = batch.find((payload) => payload.type === "stats");
	assert.equal(stats?.type, "stats");
	if (stats?.type === "stats") assert.equal(stats.contextTokens, 5);
	const latestStats = plane.records(session.id).findLast((record) => record.type === "stats");
	assert.equal(latestStats?.type, "stats");
	if (latestStats?.type === "stats") assert.equal(latestStats.contextTokens, 5);
	await node.shutdown();
});

class TestPlane implements NodePlane {
	readonly appends: Payload[][] = [];
	readonly deltas: Protocol.TurnEvent[] = [];
	readonly failures = new Set<Protocol.SessionId>();
	readonly #root: string;
	readonly #records = new Map<Protocol.SessionId, StoredRecord[]>();
	readonly #logs = new Map<Protocol.SessionId, SessionLog>();

	constructor(root: string) {
		this.#root = root;
	}

	async load(sessionId: Protocol.SessionId): Promise<StoredRecord[]> {
		if (this.failures.has(sessionId)) throw new Error("broken record chain");
		return [...(this.#records.get(sessionId) ?? [])];
	}

	async append(sessionId: Protocol.SessionId, payloads: Payload[]): Promise<StoredRecord[]> {
		this.appends.push(structuredClone(payloads));
		const log = this.#logs.get(sessionId) ?? new SessionLog(join(this.#root, `${sessionId}.jsonl`), null);
		this.#logs.set(sessionId, log);
		const records = await log.append(payloads);
		const existing = this.#records.get(sessionId) ?? [];
		existing.push(...records);
		this.#records.set(sessionId, existing);
		return records;
	}

	publish(_sessionId: Protocol.SessionId, event: Protocol.TurnEvent): void {
		this.deltas.push(event);
	}

	records(sessionId: Protocol.SessionId): StoredRecord[] {
		return [...(this.#records.get(sessionId) ?? [])];
	}
}

function createNode(plane: NodePlane): Node {
	return new Node({
		plane,
		identity: { id: "node-1", name: "test-node", createdAt: "2026-01-01T00:00:00.000Z" },
		harnessFactory: immediateFactory,
		definition: () => structuredClone(DEFINITION),
		recoveryWindowMinutes: Number.MAX_SAFE_INTEGER,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
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
			yield { actor: "process" as const, sessionId: input.sessionId, turnId: input.turnId, type: "end" as const };
		},
	};
}

async function waitForTerminal(
	plane: TestPlane,
	sessionId: Protocol.SessionId,
	turnId: Protocol.TurnId,
): Promise<void> {
	while (true) {
		const terminal = plane
			.records(sessionId)
			.some(
				(record) => record.type === "event" && record.event.type === "turn_terminal" && record.event.turnId === turnId,
			);
		if (terminal) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
