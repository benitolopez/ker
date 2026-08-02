import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import * as Agent from "@ker-ai/agent";
import * as Auth from "@ker-ai/auth";
import * as Config from "@ker-ai/config";
import * as Engine from "@ker-ai/engine";
import * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker-ai/protocol";
import {
	type AssistantRecord,
	type CatalogedSession,
	type CompactionRecord,
	type ConversationRecord,
	canonicalDirectory,
	canonicalProjectRoot,
	type Definition,
	type DefinitionRecord,
	type EventRecord,
	type IdentityRecord,
	type Payload,
	projectKey,
	SessionStore,
	type StoredRecord,
	type StoredSession,
} from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_TAIL_SIZE = 2_000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${DEFAULT_PORT}`, `localhost:${DEFAULT_PORT}`]);
const INTERRUPTED_HISTORY_MARKER =
	"The previous turn was interrupted by a daemon restart. Tools may have partially executed.";
const CANCELLED_DURING_RESTART_HISTORY_MARKER =
	"The previous turn was cancelled before a daemon restart finished cleanup. Tools may have partially executed.";

export interface Harness {
	send(input: Engine.UserMessage, signal?: AbortSignal): AsyncIterable<Protocol.TurnEvent>;
	compact(
		input: Engine.CompactionRequest,
		signal?: AbortSignal,
	): AsyncGenerator<Protocol.TurnEvent, Engine.CompactionOutcome>;
	snapshot(): Engine.HarnessState;
}

export interface DaemonOptions {
	harnessFactory?: (state: Engine.HarnessState, cwd: string) => Harness;
	definition?: (cwd: string) => Definition;
	sessionDir?: string;
	eventTailSize?: number;
	recoveryWindowMinutes?: number;
	compaction?: Config.CompactionSettings;
}

export type Daemon = Server & { shutdown(): Promise<void> };

// The HTTP server is synchronous to construct; session discovery and recovery finish before a route responds.
export function createDaemon(options: DaemonOptions = {}): Daemon {
	const manager = (async () => {
		const config = Config.loadConfig();
		const registry = new Registry({
			store: new SessionStore({ baseDir: options.sessionDir }),
			harnessFactory: options.harnessFactory ?? ((state, cwd) => createConfiguredHarness(state, cwd, config)),
			definition:
				options.definition ??
				((cwd) => {
					const { systemPrompt, tools, compaction } = Agent.createDefinition(cwd);
					return {
						systemPrompt,
						tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
						compaction,
					};
				}),
			eventTailSize: options.eventTailSize ?? DEFAULT_EVENT_TAIL_SIZE,
			recoveryWindowMinutes: options.recoveryWindowMinutes ?? config.recoveryWindowMinutes,
			compaction: options.compaction ?? config.compaction,
		});
		await registry.initialize();
		return registry;
	})();

	const server = createServer((req, res) => {
		void handleRequest(manager, req, res);
	}) as Daemon;
	server.shutdown = async () => {
		const registry = await manager;
		await registry.shutdown();
	};

	const heartbeat = setInterval(() => {
		void manager.then((registry) => registry.heartbeat()).catch(() => undefined);
	}, HEARTBEAT_MS);
	heartbeat.unref();
	server.once("close", () => clearInterval(heartbeat));
	return server;
}

interface RegistryOptions {
	store: SessionStore;
	harnessFactory: (state: Engine.HarnessState, cwd: string) => Harness;
	definition: (cwd: string) => Definition;
	eventTailSize: number;
	recoveryWindowMinutes: number;
	compaction: Config.CompactionSettings;
}

interface ActiveTurn {
	item: Protocol.QueueItem;
	delivered: boolean;
	controller: AbortController;
	done: PromiseWithResolvers<void>;
	terminal: boolean;
	cancellationRequested: boolean;
}

interface SessionState {
	stored: StoredSession;
	harness: Harness;
	persistedMessageCount: number;
	lastConversationEntryId: string | null;
	identity?: Protocol.Identity;
	model?: Protocol.Model;
	cumulativeUsage: Protocol.Usage;
	messages: Protocol.AssistantMessage[];
	active?: Protocol.ActiveAssistantMessage;
	turns: Map<Protocol.TurnId, Protocol.TurnTerminalReason>;
	epoch: string;
	sequence: number;
	tail: Protocol.EventEnvelope[];
	subscribers: Set<ServerResponse>;
	items: Map<Protocol.QueueItemId, Protocol.QueueItem>;
	queue: Protocol.QueueSnapshot;
	queueLock: Promise<void>;
	activeTurn?: ActiveTurn;
	compactionAttempted: boolean;
	compactionBackoffTokens?: number;
	compactionFailure?: { turnId: Protocol.TurnId; message: string };
}

type CatalogEntry = CatalogedSession & { stored?: StoredSession };

class SessionUnreadableError extends Error {}

class Registry {
	readonly #store: SessionStore;
	readonly #harnessFactory: (state: Engine.HarnessState, cwd: string) => Harness;
	readonly #definition: (cwd: string) => Definition;
	readonly #eventTailSize: number;
	readonly #recoveryWindowMinutes: number;
	readonly #compaction: Config.CompactionSettings;
	readonly #catalog = new Map<Protocol.SessionId, CatalogEntry>();
	readonly #states = new Map<Protocol.SessionId, Promise<SessionState>>();
	#stopping = false;

	constructor(options: RegistryOptions) {
		this.#store = options.store;
		this.#harnessFactory = options.harnessFactory;
		this.#definition = options.definition;
		this.#eventTailSize = options.eventTailSize;
		this.#recoveryWindowMinutes = options.recoveryWindowMinutes;
		this.#compaction = options.compaction;
	}

	async initialize(): Promise<void> {
		const entries = await this.#store.scanCatalog();
		for (const entry of entries) this.#catalog.set(entry.session.id, { ...entry });
		await Promise.all(entries.filter((entry) => !entry.idle).map((entry) => this.#recoverSession(entry.session.id)));
	}

	// One corrupt session must not fail startup: an unreadable load is already registered, so
	// recovery skips it while the other sessions proceed.
	async #recoverSession(sessionId: Protocol.SessionId): Promise<void> {
		let state: SessionState;
		try {
			state = await this.#state(sessionId);
		} catch (error) {
			if (error instanceof SessionUnreadableError) return;
			throw error;
		}
		await this.#withQueueLock(state, async () => {
			await this.#drainExpiredWaiting(state);
			if (state.queue.running) {
				await this.#recoverRunning(state, state.queue.running);
				return;
			}
			await this.#startNext(state);
		});
	}

	listUnreadableSessions(projectRoot?: string): Protocol.UnreadableSession[] {
		return this.#store.listUnreadable(projectRoot);
	}

	unreadableSession(sessionId: Protocol.SessionId): Protocol.UnreadableSession | undefined {
		const session = this.#store.listUnreadable().find((candidate) => candidate.id === sessionId);
		return session ? { ...session } : undefined;
	}

	async createSession(cwd: string): Promise<Protocol.SessionDescriptor> {
		const stored = await this.#store.create(cwd, this.#definition(cwd));
		this.#catalog.set(stored.session.id, {
			session: stored.session,
			path: stored.log.path,
			projectKey: projectKey(stored.session.projectRoot),
			idle: true,
			stored,
		});
		return stored.session;
	}

	listSessions(cwd?: string): Protocol.SessionDescriptor[] {
		return [...this.#catalog.values()]
			.filter((entry) => !cwd || entry.session.cwd === cwd)
			.map((entry) => ({ ...entry.session }))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	async snapshot(sessionId: Protocol.SessionId): Promise<Protocol.SessionSnapshot | undefined> {
		if (!this.#catalog.has(sessionId)) return undefined;
		const state = await this.#state(sessionId);
		return this.#withQueueLock(state, async () => {
			const turns = new Map<Protocol.TurnId, Protocol.TurnSnapshot>();
			for (const [id, status] of state.turns) turns.set(id, { id, status });
			if (state.queue.running) {
				turns.set(state.queue.running.turnId, {
					id: state.queue.running.turnId,
					status: state.queue.running.state === "cancelling" ? "cancelling" : "running",
				});
			}
			for (const item of state.queue.waiting) turns.set(item.turnId, { id: item.turnId, status: "waiting" });
			return {
				session: { ...state.stored.session },
				identity: state.identity,
				model: state.model ? { ...state.model } : undefined,
				usage: {
					contextTokens: Engine.estimateContextTokens(state.harness.snapshot().messages),
					cumulative: { ...state.cumulativeUsage },
				},
				compactionFailure: state.compactionFailure ? { ...state.compactionFailure } : undefined,
				entries: state.stored.records.flatMap((record) => {
					if (record.type === "conversation") return [toConversationEntry(record)];
					if (record.type === "compaction") return [toCompactionEntry(record)];
					return [];
				}),
				messages: state.messages.map((message) => ({ ...message })),
				active: state.active ? { ...state.active } : undefined,
				turns: [...turns.values()],
				queue: cloneQueue(state.queue),
				cursor: { epoch: state.epoch, sequence: state.sequence },
			};
		});
	}

	async subscribe(
		sessionId: Protocol.SessionId,
		cursor: Protocol.Cursor,
	): Promise<{ state: SessionState; replay: Protocol.EventEnvelope[] } | "missing" | "resync"> {
		if (!this.#catalog.has(sessionId)) return "missing";
		const state = await this.#state(sessionId);
		const firstSequence = state.tail[0]?.sequence ?? state.sequence + 1;
		if (cursor.epoch !== state.epoch || cursor.sequence > state.sequence || cursor.sequence < firstSequence - 1) {
			return "resync";
		}
		return { state, replay: state.tail.filter((envelope) => envelope.sequence > cursor.sequence) };
	}

	async admit(
		sessionId: Protocol.SessionId,
		text: string,
	): Promise<Protocol.PromptAdmission | "missing" | "context_exhausted"> {
		if (!this.#catalog.has(sessionId)) return "missing";
		const state = await this.#state(sessionId);
		return this.#withQueueLock(state, async () => {
			await this.#maybePrune(state);
			const compaction = this.#maybeCompactionItem(state);
			// The provider would reject a request this large, and nothing queued can shrink it, so the
			// refusal names a way out instead of leaving the turn to fail against the model.
			const rescued =
				compaction !== undefined || [state.queue.running, ...state.queue.waiting].some((i) => i?.kind === "compaction");
			const contextWindow = state.model?.contextWindow;
			if (
				!rescued &&
				contextWindow !== undefined &&
				Engine.estimateContextTokens(state.harness.snapshot().messages) >= contextWindow
			) {
				return "context_exhausted";
			}
			const messageId = randomUUID();
			const turnId = randomUUID();
			const queueItemId = randomUUID();
			const status: Protocol.AdmissionStatus = state.queue.running || this.#stopping ? "waiting" : "running";
			const item: Protocol.PromptQueueItem = {
				id: queueItemId,
				turnId,
				kind: "prompt",
				messageId,
				text,
				state: status,
				submittedAt: new Date().toISOString(),
			};
			state.items.set(queueItemId, item);
			if (status === "running") state.queue.running = item;
			if (status === "waiting") state.queue.waiting.push(item);
			state.queue.revision++;
			const payloads: Payload[] = [];
			if (compaction) payloads.push(this.#compactionSubmittedPayload(state, compaction, "process"));
			payloads.push(
				{
					type: "event",
					event: {
						actor: "human",
						sessionId,
						turnId,
						type: "message_submitted",
						messageId,
						queueItemId,
						text,
						admission: status,
					},
				},
				this.#queueChangedPayload(state),
			);
			await this.#appendAndPublish(state, payloads);
			if (compaction?.state === "running") this.#start(compaction, state);
			if (status === "running") this.#start(item, state);
			return {
				status,
				sessionId,
				turnId,
				messageId,
				queueItemId,
				queue: cloneQueue(state.queue),
			};
		});
	}

	async compactNow(
		sessionId: Protocol.SessionId,
		instructions?: string,
	): Promise<Protocol.CompactionAdmission | "missing"> {
		if (!this.#catalog.has(sessionId)) return "missing";
		const state = await this.#state(sessionId);
		return this.#withQueueLock(state, async () => {
			const item = this.#createCompactionItem(state, "manual", instructions);
			state.queue.revision++;
			await this.#appendAndPublish(state, [
				this.#compactionSubmittedPayload(state, item, "human"),
				this.#queueChangedPayload(state),
			]);
			if (item.state === "running") this.#start(item, state);
			return {
				status: item.state,
				sessionId,
				turnId: item.turnId,
				queueItemId: item.id,
				queue: cloneQueue(state.queue),
			};
		});
	}

	async cancel(
		sessionId: Protocol.SessionId,
		turnId: Protocol.TurnId,
	): Promise<Protocol.TurnCancellationResult | "missing" | "turn_unavailable"> {
		if (!this.#catalog.has(sessionId)) return "missing";
		const state = await this.#state(sessionId);
		return this.#withQueueLock(state, async () => {
			const terminal = state.turns.get(turnId);
			if (terminal === "aborted" || terminal === "cancelled") {
				return { status: terminal, sessionId, turnId };
			}
			if (terminal) return "turn_unavailable";

			const running = state.queue.running;
			if (running?.turnId === turnId) {
				if (running.state === "cancelling") return { status: "cancelling", sessionId, turnId };
				const active = state.activeTurn;
				if (!active || active.item.id !== running.id || active.terminal) return "turn_unavailable";
				active.cancellationRequested = true;
				const cancelling = { ...running, state: "cancelling" as const };
				active.item = cancelling;
				state.items.set(cancelling.id, cancelling);
				state.queue.running = cancelling;
				state.queue.revision++;
				await this.#appendAndPublish(state, [
					{
						type: "event",
						event: { actor: "human", sessionId, turnId, type: "turn_cancel_requested" },
					},
					this.#queueChangedPayload(state),
				]);
				active.controller.abort();
				return { status: "cancelling", sessionId, turnId };
			}
			const index = state.queue.waiting.findIndex((item) => item.turnId === turnId);
			if (index === -1) return "turn_unavailable";
			const [removed] = state.queue.waiting.splice(index, 1);
			if (!state.items.has(removed.id)) return "turn_unavailable";
			state.queue.revision++;
			const payloads: Payload[] = [
				{
					type: "event",
					event: { actor: "human", sessionId, turnId, type: "turn_cancel_requested" },
				},
			];
			if (removed.kind === "prompt") {
				payloads.push({
					type: "event",
					event: {
						actor: "process",
						sessionId,
						turnId,
						type: "message_undelivered",
						messageId: removed.messageId,
						text: removed.text,
						reason: "cancelled",
					},
				});
			}
			payloads.push(
				{ type: "event", event: { actor: "process", sessionId, turnId, type: "cancelled" } },
				{
					type: "event",
					event: { actor: "process", sessionId, turnId, type: "turn_terminal", reason: "cancelled" },
				},
				{ type: "event", event: { actor: "process", sessionId, turnId, type: "end" } },
				this.#queueChangedPayload(state),
			);
			await this.#appendAndPublish(state, payloads);
			return { status: "cancelled", sessionId, turnId };
		});
	}

	heartbeat(): void {
		for (const statePromise of this.#states.values()) {
			void statePromise.then(
				(state) => {
					for (const res of state.subscribers) {
						if (!res.destroyed) res.write(": hb\n\n");
					}
				},
				() => undefined,
			);
		}
	}

	async shutdown(): Promise<void> {
		this.#stopping = true;
		const states = (
			await Promise.all([...this.#states.values()].map((statePromise) => statePromise.catch(() => undefined)))
		).filter((state): state is SessionState => state !== undefined);
		await Promise.all(
			states.map(async (state) => {
				const active = await this.#withQueueLock(state, async () => {
					const active = state.activeTurn;
					if (!active) return undefined;
					active.controller.abort();
					return active;
				});
				await active?.done.promise;
			}),
		);
	}

	#state(sessionId: Protocol.SessionId): Promise<SessionState> {
		const existing = this.#states.get(sessionId);
		if (existing) return existing;
		const entry = this.#catalog.get(sessionId);
		if (!entry) throw new Error(`Unknown session ${sessionId}`);
		const loading = this.#openState(entry);
		this.#states.set(sessionId, loading);
		return loading;
	}

	// Sessions created this process keep their in-memory records; anything else replays its log
	// from disk on first attach. A failed load leaves the session listed only as unreadable.
	async #openState(entry: CatalogEntry): Promise<SessionState> {
		if (entry.stored) return this.#loadState(entry.stored);
		try {
			const stored = await this.#store.loadSession(entry.path);
			const current = this.#definition(stored.session.cwd);
			const last = stored.records.findLast((record): record is DefinitionRecord => record.type === "definition");
			if (!last || definitionKey(last) !== definitionKey(current)) {
				stored.records.push(...(await stored.log.append([{ type: "definition", ...current }])));
			}
			entry.stored = stored;
			entry.session = stored.session;
			return this.#loadState(stored);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#states.delete(entry.session.id);
			this.#catalog.delete(entry.session.id);
			this.#store.markUnreadable(entry.session.id, message, entry.projectKey);
			throw new SessionUnreadableError(message);
		}
	}

	#loadState(stored: StoredSession): SessionState {
		const conversation = stored.records.filter(
			(record): record is ConversationRecord => record.type === "conversation",
		);
		const projectedMessages = projectMessages(stored.records);
		const identity = stored.records.findLast(
			(record): record is IdentityRecord => record.type === "identity",
		)?.identity;
		const messages = stored.records
			.filter((record): record is AssistantRecord => record.type === "assistant")
			.map((record) => ({ ...record.message }));
		const usageEvents = stored.records.flatMap((record) =>
			record.type === "event" && record.event.type === "usage" ? [record.event] : [],
		);
		const latestUsage = usageEvents.at(-1);
		const cumulativeUsage = usageEvents.reduce((total, event) => addUsage(total, event.usage), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Protocol.Usage);
		const turns = new Map<Protocol.TurnId, Protocol.TurnTerminalReason>();
		const items = new Map<Protocol.QueueItemId, Protocol.QueueItem>();
		let queue: Protocol.QueueSnapshot = { revision: 0, waiting: [] };
		for (const record of stored.records) {
			if (record.type !== "event") continue;
			const event = record.event;
			if (event.type === "turn_terminal") turns.set(event.turnId, event.reason);
			if (event.type === "message_submitted") {
				items.set(event.queueItemId, {
					id: event.queueItemId,
					turnId: event.turnId,
					kind: "prompt",
					messageId: event.messageId,
					text: event.text,
					state: event.admission,
					submittedAt: record.at,
				});
			}
			if (event.type === "compaction_submitted") {
				items.set(event.queueItemId, {
					id: event.queueItemId,
					turnId: event.turnId,
					kind: "compaction",
					source: event.source,
					...(event.instructions === undefined ? {} : { instructions: event.instructions }),
					state: event.admission,
					submittedAt: record.at,
				});
			}
			if (event.type === "queue_changed" && event.queue.revision > queue.revision) {
				queue = normalizeQueue(event.queue);
			}
		}
		// Queue items restore from the queue snapshot, not the submission records: the snapshot
		// carries each item's original submittedAt, which recovery expiry depends on.
		const restoredRunning: Protocol.QueueItem | undefined =
			queue.running && items.has(queue.running.id)
				? { ...queue.running, state: queue.running.state === "cancelling" ? "cancelling" : "running" }
				: undefined;
		if (restoredRunning) items.set(restoredRunning.id, restoredRunning);
		const waiting = queue.waiting.flatMap((queued) => {
			if (!items.has(queued.id)) return [];
			const restored = { ...queued, state: "waiting" as const };
			items.set(restored.id, restored);
			return [restored];
		});
		const state: Engine.HarnessState = {
			messages: projectedMessages,
			identity,
		};
		return {
			stored,
			harness: this.#harnessFactory(state, stored.session.cwd),
			persistedMessageCount: state.messages.length,
			lastConversationEntryId: conversation.at(-1)?.id ?? null,
			identity,
			model: latestUsage ? Llm.getModel(latestUsage.provider, latestUsage.model) : undefined,
			cumulativeUsage,
			messages,
			turns,
			epoch: randomUUID(),
			sequence: 0,
			tail: [],
			subscribers: new Set(),
			items,
			queue: { revision: queue.revision, running: restoredRunning, waiting },
			queueLock: Promise.resolve(),
			compactionAttempted: false,
		};
	}

	#start(item: Protocol.QueueItem, state: SessionState): void {
		const turn: ActiveTurn = {
			item,
			delivered: false,
			controller: new AbortController(),
			done: Promise.withResolvers<void>(),
			terminal: false,
			cancellationRequested: false,
		};
		state.activeTurn = turn;
		if (item.kind === "compaction") {
			void this.#runCompaction(state, turn);
			return;
		}
		void this.#runTurn(state, turn);
	}

	async #runTurn(state: SessionState, turn: ActiveTurn): Promise<void> {
		if (turn.item.kind !== "prompt") throw new Error(`Queue item ${turn.item.id} is not a prompt`);
		const message: Engine.UserMessage = {
			sessionId: state.stored.session.id,
			turnId: turn.item.turnId,
			messageId: turn.item.messageId,
			text: turn.item.text,
		};
		let failureReason: "aborted" | "error" | undefined;
		try {
			for await (const event of state.harness.send(message, turn.controller.signal)) {
				if (turn.terminal) continue;
				if (event.type === "message_delivered" && event.messageId === message.messageId) turn.delivered = true;
				if (event.type === "aborted") {
					failureReason = "aborted";
				}
				if (event.type === "error") {
					failureReason = "error";
				}
				if (event.type === "end") {
					await this.#completeTurn(state, turn, failureReason);
					return;
				}
				await this.#recordHarnessEvent(state, event);
			}
		} catch (error) {
			if (!failureReason && turn.controller.signal.aborted) {
				failureReason = "aborted";
				await this.#recordHarnessEvent(state, {
					actor: "process",
					sessionId: message.sessionId,
					turnId: message.turnId,
					type: "aborted",
				});
			}
			if (!failureReason) {
				failureReason = "error";
				await this.#recordHarnessEvent(state, {
					actor: "process",
					sessionId: message.sessionId,
					turnId: message.turnId,
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			try {
				if (!turn.terminal) await this.#completeTurn(state, turn, failureReason ?? "error");
			} finally {
				turn.done.resolve();
			}
		}
	}

	async #runCompaction(state: SessionState, turn: ActiveTurn): Promise<void> {
		if (turn.item.kind !== "compaction") throw new Error(`Queue item ${turn.item.id} is not a compaction`);
		const item = turn.item;
		const scope = { sessionId: state.stored.session.id, turnId: item.turnId };
		let outcome: Engine.CompactionOutcome | undefined;
		let failure: { error: unknown } | undefined;
		try {
			const snapshot = state.harness.snapshot();
			if (snapshot.messages.length !== state.persistedMessageCount) {
				throw new Error("Cannot compact while conversation messages are awaiting persistence");
			}
			const previousSummary = state.stored.records.findLast(
				(record): record is CompactionRecord => record.type === "compaction",
			)?.summary;
			const generator = state.harness.compact(
				{
					...scope,
					keepRecentTokens: this.#compaction.keepRecentTokens,
					...(state.model?.contextWindow === undefined ? {} : { contextWindow: state.model.contextWindow }),
					...(this.#compaction.reasoningEffort === undefined
						? {}
						: { reasoningEffort: this.#compaction.reasoningEffort }),
					...(item.instructions === undefined ? {} : { instructions: item.instructions }),
					...(previousSummary === undefined ? {} : { previousSummary }),
				},
				turn.controller.signal,
			);
			while (true) {
				const next = await generator.next();
				if (next.done) {
					outcome = next.value;
					break;
				}
				if (!turn.terminal) await this.#recordHarnessEvent(state, next.value);
			}
		} catch (error) {
			failure = { error };
		}

		try {
			await this.#withQueueLock(state, async () => {
				if (state.activeTurn !== turn || turn.terminal) return;
				const aborted = turn.cancellationRequested || turn.controller.signal.aborted || outcome?.kind === "aborted";
				if (aborted) {
					await this.#recordHarnessEvent(state, { actor: "process", ...scope, type: "aborted" });
					await this.#finishTurn(state, turn, "aborted");
					state.activeTurn = undefined;
					await this.#advanceQueue(state, item.id);
					return;
				}
				if (failure !== undefined) {
					const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
					await this.#recordHarnessEvent(state, { actor: "process", ...scope, type: "error", message });
					this.#backOffCompaction(state, item, message);
					await this.#finishTurn(state, turn, "error");
					state.activeTurn = undefined;
					await this.#advanceQueue(state, item.id);
					return;
				}
				if (!outcome || outcome.kind === "stopped" || outcome.kind === "aborted") {
					if (!(outcome?.kind === "stopped" && outcome.retryable)) this.#backOffCompaction(state, item);
					await this.#finishTurn(state, turn, "error");
					state.activeTurn = undefined;
					await this.#advanceQueue(state, item.id);
					return;
				}
				if (outcome.kind === "skipped") {
					await this.#recordHarnessEvent(state, {
						actor: "process",
						...scope,
						type: "compaction_skipped",
						reason: outcome.reason,
					});
					this.#backOffCompaction(state, item);
					await this.#finishTurn(state, turn);
					state.activeTurn = undefined;
					await this.#advanceQueue(state, item.id);
					return;
				}

				const trigger =
					state.model?.contextWindow === undefined
						? undefined
						: state.model.contextWindow - this.#compaction.reserveTokens;
				const watermark =
					item.source === "auto" && trigger !== undefined && trigger > 0
						? trigger - Math.min(this.#compaction.reserveTokens, Math.floor(trigger / 2))
						: undefined;
				const gateError =
					outcome.tokensAfter >= outcome.tokensBefore
						? `Compaction did not reduce the context (${outcome.tokensBefore} → ${outcome.tokensAfter} tokens)`
						: watermark !== undefined && outcome.tokensAfter > watermark
							? "Compacted context is still too close to the compaction threshold"
							: undefined;
				if (gateError) {
					await this.#recordHarnessEvent(state, {
						actor: "process",
						...scope,
						type: "error",
						message: gateError,
					});
					this.#backOffCompaction(state, item, gateError);
					await this.#finishTurn(state, turn, "error");
					state.activeTurn = undefined;
					await this.#advanceQueue(state, item.id);
					return;
				}

				const conversation = state.stored.records.filter(
					(record): record is ConversationRecord => record.type === "conversation",
				);
				const firstKept = conversation.at(-outcome.keptCount);
				if (!firstKept) {
					await this.#recordHarnessEvent(state, {
						actor: "process",
						...scope,
						type: "error",
						message: "Compaction kept messages that do not map to the transcript",
					});
					await this.#finishTurn(state, turn, "error");
					state.activeTurn = undefined;
					await this.#advanceQueue(state, item.id);
					return;
				}
				await this.#appendAndPublish(state, [
					{
						type: "compaction",
						turnId: item.turnId,
						summary: outcome.summary,
						firstKeptEntryId: firstKept.id,
						tokensBefore: outcome.tokensBefore,
						tokensAfter: outcome.tokensAfter,
						budgetChars: outcome.budgetChars,
						reasoningEffort: outcome.reasoningEffort,
					},
					{
						type: "event",
						event: {
							actor: "process",
							...scope,
							type: "compacted",
							summary: outcome.summary,
							tokensBefore: outcome.tokensBefore,
							tokensAfter: outcome.tokensAfter,
							firstKeptEntryId: firstKept.id,
						},
					},
				]);
				state.harness = this.#harnessFactory(
					{ messages: outcome.messages, identity: state.identity },
					state.stored.session.cwd,
				);
				state.persistedMessageCount = outcome.messages.length;
				state.compactionBackoffTokens = undefined;
				state.compactionFailure = undefined;
				await this.#finishTurn(state, turn);
				state.activeTurn = undefined;
				await this.#advanceQueue(state, item.id);
			});
		} finally {
			turn.done.resolve();
		}
	}

	async #completeTurn(state: SessionState, turn: ActiveTurn, failureReason?: "aborted" | "error"): Promise<void> {
		await this.#withQueueLock(state, async () => {
			if (state.activeTurn !== turn || turn.terminal) return;
			const aborted = turn.cancellationRequested || turn.controller.signal.aborted;
			const finalFailure = aborted ? "aborted" : failureReason;
			if (aborted && failureReason !== "aborted") {
				await this.#recordHarnessEvent(state, {
					actor: "process",
					sessionId: state.stored.session.id,
					turnId: turn.item.turnId,
					type: "aborted",
				});
			}
			await this.#finishTurn(state, turn, finalFailure);
			state.activeTurn = undefined;
			await this.#advanceQueue(state, turn.item.id);
		});
	}

	async #finishTurn(state: SessionState, turn: ActiveTurn, failureReason?: "aborted" | "error"): Promise<void> {
		const scope = { sessionId: state.stored.session.id, turnId: turn.item.turnId };
		const promptIncomplete = turn.item.kind === "prompt" && (!turn.delivered || state.active !== undefined);
		const reason = failureReason ?? (promptIncomplete ? "error" : "completed");
		if (!failureReason && reason === "error") {
			await this.#recordHarnessEvent(state, {
				actor: "process",
				...scope,
				type: "error",
				message: "The turn ended before all submitted input and model output became terminal",
			});
		}
		if (turn.item.kind === "prompt" && !turn.delivered) {
			const undeliveredReason = reason === "completed" ? "error" : reason;
			await this.#recordHarnessEvent(state, {
				actor: "process",
				...scope,
				type: "message_undelivered",
				messageId: turn.item.messageId,
				text: turn.item.text,
				reason: undeliveredReason,
			});
		}
		await this.#appendAndPublish(state, [
			{ type: "event", event: { actor: "process", ...scope, type: "turn_terminal", reason } },
			{ type: "event", event: { actor: "process", ...scope, type: "end" } },
		]);
		turn.terminal = true;
	}

	async #recordHarnessEvent(state: SessionState, event: Protocol.TurnEvent): Promise<void> {
		if (event.type === "message_delta" || event.type === "reasoning_delta") {
			this.#publishEvent(state, event);
			return;
		}
		const snapshot = state.harness.snapshot();
		const payloads: Payload[] = [{ type: "event", event }];
		const identityChanged = snapshot.identity && !sameIdentity(snapshot.identity, state.identity);
		if (identityChanged && snapshot.identity) payloads.push({ type: "identity", identity: snapshot.identity });
		const addedMessages = snapshot.messages.slice(state.persistedMessageCount);
		const entries: Array<Extract<Payload, { type: "conversation" }>> = [];
		let parent = state.lastConversationEntryId;
		for (const message of addedMessages) {
			const entryId = randomUUID();
			entries.push({
				type: "conversation",
				id: entryId,
				parentId: parent,
				turnId: event.turnId,
				messageId:
					message.role === "user" && event.type === "message_delivered"
						? event.messageId
						: message.role === "assistant" && event.type === "assistant_message_completed"
							? event.messageId
							: undefined,
				message,
			});
			parent = entryId;
		}
		payloads.push(...entries);
		const assistant = assistantTerminalPayload(state, event);
		if (assistant) payloads.push(assistant);
		await this.#appendAndPublish(state, payloads);
		state.persistedMessageCount = snapshot.messages.length;
		state.lastConversationEntryId = parent;
		if (snapshot.identity) state.identity = snapshot.identity;
	}

	async #appendAndPublish(state: SessionState, payloads: Payload[]): Promise<void> {
		const records = await state.stored.log.append(payloads);
		state.stored.records.push(...records);
		const updatedAt = records.at(-1)?.at;
		if (updatedAt) state.stored.session.updatedAt = updatedAt;
		for (const record of records) {
			if (record.type === "assistant") {
				state.messages.push({ ...record.message });
				if (state.active?.id === record.message.id) state.active = undefined;
			}
			if (record.type !== "event") continue;
			this.#publishEvent(state, record.event);
		}
	}

	#publishEvent(state: SessionState, event: Protocol.Event): void {
		this.#applyEvent(state, event);
		const envelope: Protocol.EventEnvelope = {
			epoch: state.epoch,
			sequence: ++state.sequence,
			event,
		};
		state.tail.push(envelope);
		if (state.tail.length > this.#eventTailSize) state.tail.shift();
		const frame = `id: ${envelope.epoch}:${envelope.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`;
		for (const res of state.subscribers) {
			if (!res.destroyed) res.write(frame);
		}
	}

	#applyEvent(state: SessionState, event: Protocol.Event): void {
		if (event.type === "message_delta") {
			const active = state.active?.id === event.messageId ? state.active : undefined;
			if (!active) {
				state.active = { id: event.messageId, turnId: event.turnId, text: event.text };
				return;
			}
			if (event.offset !== active.text.length) throw new Error(`Non-contiguous assistant message ${event.messageId}`);
			active.text += event.text;
		}
		if (event.type === "usage") {
			state.model = Llm.getModel(event.provider, event.model);
			state.cumulativeUsage = addUsage(state.cumulativeUsage, event.usage);
			const compactionPending = [state.queue.running, ...state.queue.waiting].some(
				(item) => item?.kind === "compaction",
			);
			if (!compactionPending) state.compactionAttempted = false;
		}
		if (event.type === "turn_terminal") state.turns.set(event.turnId, event.reason);
	}

	#queueChangedPayload(state: SessionState): Extract<Payload, { type: "event" }> {
		return {
			type: "event",
			event: {
				actor: "process",
				sessionId: state.stored.session.id,
				type: "queue_changed",
				queue: cloneQueue(state.queue),
			},
		};
	}

	// Runs only during restart recovery, never while the daemon is live: waiting work older
	// than the recovery window is dropped as expired instead of auto-running unattended.
	async #drainExpiredWaiting(state: SessionState): Promise<void> {
		if (state.queue.waiting.length === 0) return;
		const now = Date.now();
		const windowMs = this.#recoveryWindowMinutes * 60_000;
		const isFresh = (item: Protocol.QueueItem) =>
			this.#recoveryWindowMinutes > 0 && now - Date.parse(item.submittedAt) <= windowMs;
		const expired = state.queue.waiting.filter((item) => !isFresh(item));
		if (expired.length === 0) return;
		state.queue.waiting = state.queue.waiting.filter(isFresh);
		state.queue.revision++;
		const payloads: Payload[] = expired.flatMap((item): Payload[] => {
			const scope = { sessionId: state.stored.session.id, turnId: item.turnId };
			const terminal: Payload[] = [];
			if (item.kind === "prompt") {
				terminal.push({
					type: "event",
					event: {
						actor: "process",
						...scope,
						type: "message_undelivered",
						messageId: item.messageId,
						text: item.text,
						reason: "expired",
					},
				});
			}
			terminal.push(
				{ type: "event", event: { actor: "process", ...scope, type: "turn_terminal", reason: "expired" } },
				{ type: "event", event: { actor: "process", ...scope, type: "end" } },
			);
			return terminal;
		});
		payloads.push(this.#queueChangedPayload(state));
		await this.#appendAndPublish(state, payloads);
	}

	async #recoverRunning(state: SessionState, item: Protocol.QueueItem): Promise<void> {
		const scope = { sessionId: state.stored.session.id, turnId: item.turnId };
		const cancellation = item.state === "cancelling";
		if (state.turns.has(item.turnId)) {
			const hasEnd = state.stored.records.some(
				(record) => record.type === "event" && record.event.type === "end" && record.event.turnId === item.turnId,
			);
			if (!hasEnd) {
				await this.#appendAndPublish(state, [{ type: "event", event: { actor: "process", ...scope, type: "end" } }]);
			}
			await this.#advanceQueue(state, item.id);
			return;
		}
		if (item.kind === "compaction") {
			const compacted = state.stored.records.some(
				(record) => record.type === "compaction" && record.turnId === item.turnId,
			);
			const reason = compacted ? "completed" : cancellation ? "aborted" : "interrupted";
			const payloads: Payload[] = [];
			if (!compacted) {
				payloads.push({
					type: "event",
					event: {
						actor: "process",
						...scope,
						type: cancellation ? "aborted" : "interrupted",
					},
				});
			}
			payloads.push(
				{ type: "event", event: { actor: "process", ...scope, type: "turn_terminal", reason } },
				{ type: "event", event: { actor: "process", ...scope, type: "end" } },
			);
			await this.#appendAndPublish(state, payloads);
			await this.#advanceQueue(state, item.id);
			return;
		}
		const submitted = state.stored.records
			.filter((record): record is EventRecord => record.type === "event")
			.map((record) => record.event)
			.filter(
				(event): event is Protocol.MessageSubmittedEvent =>
					event.type === "message_submitted" && event.turnId === item.turnId,
			);
		const delivered = new Set(
			state.stored.records
				.filter((record): record is EventRecord => record.type === "event")
				.map((record) => record.event)
				.flatMap((event) =>
					event.type === "message_delivered" && event.turnId === item.turnId ? [event.messageId] : [],
				),
		);
		const settled = new Set(
			state.stored.records
				.filter((record): record is EventRecord => record.type === "event")
				.map((record) => record.event)
				.flatMap((event) =>
					event.type === "message_delivered" || event.type === "message_undelivered" ? [event.messageId] : [],
				),
		);
		const history = state.harness.snapshot();
		const toolResults = new Set(
			history.messages.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
		);
		const outstanding = history.messages.findLast((message) => message.role === "assistant")?.toolCalls ?? [];
		const repairs = outstanding.filter((call) => !toolResults.has(call.callId));
		const repairedMessages: Engine.HarnessState["messages"] = repairs.map((call) => ({
			role: "tool",
			toolCallId: call.callId,
			content: "Tool result unavailable because the daemon stopped during the turn.",
		}));
		if (delivered.size > 0 || repairs.length > 0) {
			repairedMessages.push({
				role: "developer",
				content: cancellation ? CANCELLED_DURING_RESTART_HISTORY_MARKER : INTERRUPTED_HISTORY_MARKER,
			});
		}

		const payloads: Payload[] = [];
		let parent = state.lastConversationEntryId;
		for (const [index, message] of repairedMessages.entries()) {
			const entryId = randomUUID();
			payloads.push({
				type: "conversation",
				id: entryId,
				parentId: parent,
				turnId: item.turnId,
				message,
			});
			parent = entryId;
			const call = repairs[index];
			if (call) {
				payloads.push({
					type: "event",
					event: {
						actor: "process",
						modelRole: "tool",
						...scope,
						type: "tool_result",
						id: call.callId,
						name: call.name,
						status: "error",
						output: "Tool result unavailable because the daemon stopped during the turn.",
					},
				});
			}
		}
		for (const event of submitted) {
			if (settled.has(event.messageId)) continue;
			payloads.push({
				type: "event",
				event: {
					actor: "process",
					...scope,
					type: "message_undelivered",
					messageId: event.messageId,
					text: event.text,
					reason: cancellation ? "aborted" : "interrupted",
				},
			});
		}
		payloads.push(
			{
				type: "event",
				event: { actor: "process", ...scope, type: cancellation ? "aborted" : "interrupted" },
			},
			{
				type: "event",
				event: {
					actor: "process",
					...scope,
					type: "turn_terminal",
					reason: cancellation ? "aborted" : "interrupted",
				},
			},
			{ type: "event", event: { actor: "process", ...scope, type: "end" } },
		);
		await this.#appendAndPublish(state, payloads);
		state.lastConversationEntryId = parent;
		const nextHistory = [...history.messages, ...repairedMessages];
		state.harness = this.#harnessFactory(
			{ messages: nextHistory, identity: history.identity },
			state.stored.session.cwd,
		);
		state.persistedMessageCount = nextHistory.length;
		await this.#advanceQueue(state, item.id);
	}

	async #advanceQueue(state: SessionState, finishedItemId: Protocol.QueueItemId): Promise<void> {
		if (state.queue.running?.id !== finishedItemId) return;
		state.queue.running = undefined;
		await this.#maybePrune(state);
		const compaction = this.#maybeCompactionItem(state);
		const next = compaction ? undefined : this.#stopping ? undefined : state.queue.waiting.shift();
		const item = compaction ?? (next ? state.items.get(next.id) : undefined);
		if (next && !item) throw new Error(`Queue item ${next.id} has no submission event`);
		const running = item ? { ...item, state: "running" as const } : undefined;
		if (running) state.items.set(running.id, running);
		state.queue.running = running;
		state.queue.revision++;
		const payloads: Payload[] = [];
		if (compaction) payloads.push(this.#compactionSubmittedPayload(state, compaction, "process"));
		payloads.push(this.#queueChangedPayload(state));
		await this.#appendAndPublish(state, payloads);
		if (running) this.#start(running, state);
	}

	async #startNext(state: SessionState): Promise<void> {
		if (this.#stopping || state.queue.running) return;
		await this.#maybePrune(state);
		const compaction = this.#maybeCompactionItem(state);
		const next = compaction ? undefined : state.queue.waiting.shift();
		const item = compaction ?? (next ? state.items.get(next.id) : undefined);
		if (!item) {
			if (next) throw new Error(`Queue item ${next.id} has no submission event`);
			return;
		}
		const running = { ...item, state: "running" as const };
		state.items.set(running.id, running);
		state.queue.running = running;
		state.queue.revision++;
		const payloads: Payload[] = [];
		if (compaction) payloads.push(this.#compactionSubmittedPayload(state, compaction, "process"));
		payloads.push(this.#queueChangedPayload(state));
		await this.#appendAndPublish(state, payloads);
		this.#start(running, state);
	}

	async #maybePrune(state: SessionState): Promise<void> {
		const contextWindow = state.model?.contextWindow;
		if (this.#stopping || !this.#compaction.prune || contextWindow === undefined || state.activeTurn) return;
		const snapshot = state.harness.snapshot();
		if (snapshot.messages.length !== state.persistedMessageCount) return;
		const trigger = contextWindow - this.#compaction.reserveTokens;
		if (trigger <= 0) return;
		if (Engine.estimateContextTokens(snapshot.messages) <= trigger) return;
		const outcome = Engine.pruneToolOutputs(snapshot.messages);
		if (!outcome) return;

		const replacement = this.#harnessFactory(
			{ messages: outcome.messages, identity: state.identity },
			state.stored.session.cwd,
		);
		state.queue.revision++;
		await this.#appendAndPublish(state, [
			{
				type: "prune",
				toolCallIds: outcome.toolCallIds,
				tokensBefore: outcome.tokensBefore,
				tokensAfter: outcome.tokensAfter,
			},
			{
				type: "event",
				event: {
					actor: "process",
					sessionId: state.stored.session.id,
					type: "pruned",
					toolCallIds: outcome.toolCallIds,
					tokensBefore: outcome.tokensBefore,
					tokensAfter: outcome.tokensAfter,
				},
			},
			this.#queueChangedPayload(state),
		]);
		state.harness = replacement;
		state.persistedMessageCount = outcome.messages.length;
	}

	#maybeCompactionItem(
		state: SessionState,
	): (Protocol.CompactionQueueItem & { state: Protocol.AdmissionStatus }) | undefined {
		if (
			this.#stopping ||
			!this.#compaction.enabled ||
			state.compactionAttempted ||
			[state.queue.running, ...state.queue.waiting].some((item) => item?.kind === "compaction")
		) {
			return undefined;
		}
		const contextWindow = state.model?.contextWindow;
		if (contextWindow === undefined) return undefined;
		const trigger = contextWindow - this.#compaction.reserveTokens;
		if (trigger <= 0) return undefined;
		const estimate = Engine.estimateContextTokens(state.harness.snapshot().messages);
		if (estimate <= trigger) return undefined;
		const mark = state.compactionBackoffTokens;
		if (mark !== undefined && estimate <= mark + Math.max(1, Math.floor((contextWindow - mark) / 2))) {
			return undefined;
		}
		return this.#createCompactionItem(state, "auto");
	}

	// A compaction that failed for a reason the conversation controls repeats identically, so the next
	// automatic attempt waits until the context has grown halfway to the window. Transient provider
	// failures skip this and retry on the next turn, paced by compactionAttempted alone.
	#backOffCompaction(state: SessionState, item: Protocol.CompactionQueueItem, message?: string): void {
		if (item.source !== "auto") return;
		state.compactionBackoffTokens = Engine.estimateContextTokens(state.harness.snapshot().messages);
		if (message !== undefined) state.compactionFailure = { turnId: item.turnId, message };
	}

	#createCompactionItem(
		state: SessionState,
		source: Protocol.CompactionSource,
		instructions?: string,
	): Protocol.CompactionQueueItem & { state: Protocol.AdmissionStatus } {
		const status: Protocol.AdmissionStatus = state.queue.running || this.#stopping ? "waiting" : "running";
		const item: Protocol.CompactionQueueItem & { state: Protocol.AdmissionStatus } = {
			id: randomUUID(),
			turnId: randomUUID(),
			kind: "compaction",
			source,
			...(instructions === undefined ? {} : { instructions }),
			state: status,
			submittedAt: new Date().toISOString(),
		};
		state.compactionAttempted = true;
		state.items.set(item.id, item);
		if (status === "running") state.queue.running = item;
		if (status === "waiting") state.queue.waiting.push(item);
		return item;
	}

	#compactionSubmittedPayload(
		state: SessionState,
		item: Protocol.CompactionQueueItem & { state: Protocol.AdmissionStatus },
		actor: "human" | "process",
	): Extract<Payload, { type: "event" }> {
		return {
			type: "event",
			event: {
				actor,
				sessionId: state.stored.session.id,
				turnId: item.turnId,
				type: "compaction_submitted",
				queueItemId: item.id,
				source: item.source,
				...(item.instructions === undefined ? {} : { instructions: item.instructions }),
				admission: item.state,
			},
		};
	}

	#withQueueLock<T>(state: SessionState, operation: () => Promise<T>): Promise<T> {
		const running = state.queueLock.then(operation, operation);
		state.queueLock = running.then(
			() => undefined,
			() => undefined,
		);
		return running;
	}
}

interface ProjectedMessage {
	message: Llm.Message;
	entryId?: string;
}

// Applies context mutations in log order. Compaction slices the current projection so an earlier
// prune stays applied when its tool result falls inside the kept tail.
function projectMessages(records: readonly StoredRecord[]): Llm.Message[] {
	let projected: ProjectedMessage[] = [];
	for (const record of records) {
		if (record.type === "conversation") {
			projected.push({ message: structuredClone(record.message), entryId: record.id });
			continue;
		}
		if (record.type === "prune") {
			const messages = Engine.applyPrune(
				projected.map((entry) => entry.message),
				record.toolCallIds,
			);
			projected = projected.map((entry, index) => ({ ...entry, message: messages[index] }));
			continue;
		}
		if (record.type !== "compaction") continue;
		const firstKeptIndex = projected.findIndex((entry) => entry.entryId === record.firstKeptEntryId);
		if (firstKeptIndex === -1) {
			throw new Error(`Compaction ${record.recordId} refers to missing conversation entry ${record.firstKeptEntryId}`);
		}
		projected = [
			{ message: Engine.compactionSummaryMessage(record.summary) },
			...projected
				.slice(firstKeptIndex)
				.map((entry) => ({ ...entry, message: Engine.stripAssistantMetadata(entry.message) })),
		];
	}
	return projected.map((entry) => entry.message);
}

async function handleRequest(managerPromise: Promise<Registry>, req: IncomingMessage, res: ServerResponse) {
	if (!isLocalRequest(req)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const manager = await managerPromise;
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		if (req.method === "GET" && url.pathname === "/health") {
			writeJson(res, 200, { name: "ker", protocol: PROTOCOL_VERSION });
			return;
		}
		if (req.method === "POST" && url.pathname === "/sessions") {
			const cwd = await readCreateSessionCwd(req, res);
			if (!cwd) return;
			writeJson(res, 201, await manager.createSession(cwd));
			return;
		}
		if (req.method === "GET" && url.pathname === "/sessions") {
			const scope = await readListSessionScope(url, res);
			if (!scope) return;
			const body: Protocol.ListSessionsResponse =
				scope.type === "all"
					? {
							sessions: manager.listSessions(),
							unreadable: manager.listUnreadableSessions(),
						}
					: {
							sessions: manager.listSessions(scope.cwd),
							unreadable: manager.listUnreadableSessions(scope.projectRoot),
						};
			writeJson(res, 200, body);
			return;
		}
		const snapshotMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
		if (req.method === "GET" && snapshotMatch) {
			const sessionId = decodeURIComponent(snapshotMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const snapshot = await manager.snapshot(sessionId);
			if (!snapshot) {
				res.writeHead(404).end();
				return;
			}
			writeJson(res, 200, snapshot);
			return;
		}

		const eventMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
		if (req.method === "GET" && eventMatch) {
			const sessionId = decodeURIComponent(eventMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const sequence = Number(url.searchParams.get("sequence"));
			const epoch = url.searchParams.get("epoch");
			if (!epoch || !Number.isSafeInteger(sequence) || sequence < 0) {
				writeJson(res, 400, { code: "invalid_cursor" });
				return;
			}
			const subscription = await manager.subscribe(sessionId, { epoch, sequence });
			if (subscription === "missing") {
				res.writeHead(404).end();
				return;
			}
			if (subscription === "resync") {
				writeJson(res, 410, { code: "resync_required" });
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			for (const envelope of subscription.replay) {
				res.write(`id: ${envelope.epoch}:${envelope.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`);
			}
			res.flushHeaders();
			subscription.state.subscribers.add(res);
			res.on("close", () => subscription.state.subscribers.delete(res));
			return;
		}

		const promptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompts$/);
		if (req.method === "POST" && promptMatch) {
			const sessionId = decodeURIComponent(promptMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const parsed = await readJsonBody(req, res);
			if (parsed === undefined) return;
			const prompt = parsePromptRequest(parsed);
			if (!prompt) {
				writeJson(res, 400, { code: "invalid_prompt" });
				return;
			}
			const admitted = await manager.admit(sessionId, prompt.text);
			if (admitted === "missing") {
				res.writeHead(404).end();
				return;
			}
			if (admitted === "context_exhausted") {
				writeJson(res, 409, { code: "context_exhausted" });
				return;
			}
			writeJson(res, 202, admitted);
			return;
		}

		const compactMatch = url.pathname.match(/^\/sessions\/([^/]+)\/compact$/);
		if (req.method === "POST" && compactMatch) {
			const sessionId = decodeURIComponent(compactMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const parsed = await readJsonBody(req, res);
			if (parsed === undefined) return;
			const compact = parseCompactRequest(parsed);
			if (!compact) {
				writeJson(res, 400, { code: "invalid_compaction" });
				return;
			}
			const admitted = await manager.compactNow(sessionId, compact.instructions);
			if (admitted === "missing") {
				res.writeHead(404).end();
				return;
			}
			writeJson(res, 202, admitted);
			return;
		}

		const cancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/cancel$/);
		if (req.method === "POST" && cancelMatch) {
			const sessionId = decodeURIComponent(cancelMatch[1]);
			if (writeUnreadableSession(manager, sessionId, res)) return;
			const result = await manager.cancel(sessionId, decodeURIComponent(cancelMatch[2]));
			if (result === "missing") {
				res.writeHead(404).end();
				return;
			}
			if (result === "turn_unavailable") {
				writeJson(res, 409, { code: "turn_unavailable" });
				return;
			}
			writeJson(res, result.status === "cancelling" ? 202 : 200, result);
			return;
		}
		res.writeHead(404).end();
	} catch (error) {
		if (!res.headersSent) {
			if (error instanceof SessionUnreadableError) {
				writeJson(res, 500, { code: "session_unreadable", error: error.message });
				return;
			}
			writeJson(res, error instanceof SyntaxError ? 400 : 500, {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		res.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}

function writeUnreadableSession(manager: Registry, sessionId: Protocol.SessionId, res: ServerResponse): boolean {
	const unreadable = manager.unreadableSession(sessionId);
	if (!unreadable) return false;
	writeJson(res, 500, { code: "session_unreadable", error: unreadable.error });
	return true;
}

function assistantTerminalPayload(
	state: SessionState,
	event: Protocol.TurnEvent,
): Extract<Payload, { type: "assistant" }> | undefined {
	if (!state.active || state.active.turnId !== event.turnId) return undefined;
	if (event.type === "assistant_message_completed" && event.messageId === state.active.id) {
		return { type: "assistant", message: { ...state.active, reason: event.reason } };
	}
	if (event.type === "error") return { type: "assistant", message: { ...state.active, reason: "error" } };
	if (event.type === "aborted") return { type: "assistant", message: { ...state.active, reason: "aborted" } };
	return undefined;
}

function toConversationEntry(record: ConversationRecord): Protocol.ConversationEntry {
	const base = {
		id: record.id,
		parentId: record.parentId,
		turnId: record.turnId,
		messageId: record.messageId,
	};
	if (record.message.role === "user" || record.message.role === "developer") {
		return { ...base, role: record.message.role, content: record.message.content };
	}
	if (record.message.role === "tool") {
		return {
			...base,
			role: "tool",
			toolCallId: record.message.toolCallId,
			content: record.message.content,
		};
	}
	return {
		...base,
		role: "assistant",
		content: record.message.content,
		...(record.message.reasoningSummary === undefined ? {} : { reasoningSummary: record.message.reasoningSummary }),
		toolCalls: (record.message.toolCalls ?? []).map((call) => ({
			id: call.callId,
			name: call.name,
			arguments: call.arguments,
		})),
	};
}

function toCompactionEntry(record: CompactionRecord): Protocol.ConversationEntry {
	return {
		id: record.recordId,
		parentId: null,
		turnId: record.turnId,
		role: "compaction",
		summary: record.summary,
		tokensBefore: record.tokensBefore,
		tokensAfter: record.tokensAfter,
		firstKeptEntryId: record.firstKeptEntryId,
	};
}

// Compares only model-visible definition fields so record ids and timestamps cannot cause a mismatch.
function definitionKey(definition: Definition): string {
	return JSON.stringify([
		definition.systemPrompt,
		definition.tools.map((tool) => [tool.name, tool.description, tool.parameters]),
		definition.compaction.systemPrompt,
		definition.compaction.initialInstructions,
		definition.compaction.updateInstructions,
	]);
}

function createConfiguredHarness(state: Engine.HarnessState, cwd: string, config: Config.Config): Harness {
	const definition = Agent.createDefinition(cwd);
	return Engine.createHarness(
		{
			model: config.model,
			getAuth: (signal) => Auth.resolveAuth(config.apiKey, signal),
			tools: definition.tools,
			systemPrompt: definition.systemPrompt,
			compaction: definition.compaction,
			reasoningEffort: config.reasoningEffort,
		},
		undefined,
		state,
	);
}

interface PromptRequest {
	text: string;
}

type ListSessionScope = { type: "all" } | { type: "cwd"; cwd: string; projectRoot: string };

async function readCreateSessionCwd(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
	const parsed = await readJsonBody(req, res);
	if (parsed === undefined) return undefined;
	const request = parseCreateSessionRequest(parsed);
	if (!request) {
		writeJson(res, 400, { code: "invalid_cwd" });
		return undefined;
	}
	try {
		return await canonicalDirectory(request.cwd);
	} catch {
		writeJson(res, 400, { code: "invalid_cwd" });
		return undefined;
	}
}

async function readListSessionScope(url: URL, res: ServerResponse): Promise<ListSessionScope | undefined> {
	const parameters = [...url.searchParams.entries()];
	if (parameters.length === 1 && parameters[0][0] === "scope" && parameters[0][1] === "all") {
		return { type: "all" };
	}
	if (parameters.length !== 1 || parameters[0][0] !== "cwd") {
		writeJson(res, 400, { code: "invalid_scope" });
		return undefined;
	}
	try {
		const cwd = await canonicalDirectory(parameters[0][1]);
		return { type: "cwd", cwd, projectRoot: await canonicalProjectRoot(cwd) };
	} catch {
		writeJson(res, 400, { code: "invalid_cwd" });
		return undefined;
	}
}

function parseCreateSessionRequest(value: unknown): Protocol.CreateSessionRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const request = value as Record<string, unknown>;
	if (Object.keys(request).length !== 1 || typeof request.cwd !== "string") return undefined;
	return { cwd: request.cwd };
}

function parsePromptRequest(value: unknown): PromptRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prompt = value as Record<string, unknown>;
	if (Object.keys(prompt).length !== 1 || typeof prompt.text !== "string" || prompt.text.trim() === "") {
		return undefined;
	}
	return { text: prompt.text };
}

function parseCompactRequest(value: unknown): Protocol.CompactRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const compact = value as Record<string, unknown>;
	if (Object.keys(compact).some((key) => key !== "instructions")) return undefined;
	if (
		compact.instructions !== undefined &&
		(typeof compact.instructions !== "string" || compact.instructions.trim() === "")
	) {
		return undefined;
	}
	return compact.instructions === undefined ? {} : { instructions: compact.instructions };
}

function normalizeQueue(queue: Protocol.QueueSnapshot): Protocol.QueueSnapshot {
	return {
		revision: queue.revision,
		running: queue.running ? normalizeQueueItem(queue.running) : undefined,
		waiting: queue.waiting.map(normalizeQueueItem),
	};
}

function normalizeQueueItem(item: Protocol.QueueItem): Protocol.QueueItem {
	if (item.kind === "prompt" || item.kind === "compaction") return { ...item };
	const legacy = item as Omit<Protocol.PromptQueueItem, "kind">;
	return { ...legacy, kind: "prompt" };
}

function cloneQueue(queue: Protocol.QueueSnapshot): Protocol.QueueSnapshot {
	return {
		revision: queue.revision,
		running: queue.running ? { ...queue.running } : undefined,
		waiting: queue.waiting.map((item) => ({ ...item })),
	};
}

function addUsage(left: Protocol.Usage, right: Protocol.Usage): Protocol.Usage {
	const reasoning =
		left.reasoning === undefined && right.reasoning === undefined
			? undefined
			: (left.reasoning ?? 0) + (right.reasoning ?? 0);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(reasoning === undefined ? {} : { reasoning }),
		total: left.total + right.total,
	};
}

function sameIdentity(left: Protocol.Identity, right?: Protocol.Identity): boolean {
	if (!right || left.kind !== right.kind) return false;
	if (left.kind === "oauth" && right.kind === "oauth") return left.accountId === right.accountId;
	return true;
}

function isLocalRequest(req: IncomingMessage): boolean {
	if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return false;
	const origin = req.headers.origin;
	return origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
	if (!req.headers["content-type"]?.startsWith("application/json")) {
		res.writeHead(415).end();
		return undefined;
	}
	if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
		res.writeHead(413).end();
		return undefined;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			res.writeHead(413).end();
			return undefined;
		}
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(res: ServerResponse, status: number, body: object): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
