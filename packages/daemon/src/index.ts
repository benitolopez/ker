import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import * as Agent from "@ker-ai/agent";
import * as Auth from "@ker-ai/auth";
import * as Config from "@ker-ai/config";
import * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "@ker-ai/protocol";
import {
	type AssistantRecord,
	type ConversationRecord,
	canonicalProjectRoot,
	type EventRecord,
	type IdentityRecord,
	type Payload,
	SessionStore,
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
	send(input: Engine.TurnInput, signal?: AbortSignal): AsyncIterable<Protocol.TurnEvent>;
	snapshot(): Engine.HarnessState;
}

export interface DaemonOptions {
	harnessFactory?: (state: Engine.HarnessState) => Harness;
	sessionDir?: string;
	cwd?: string;
	projectRoot?: string;
	eventTailSize?: number;
}

export type Daemon = Server & { shutdown(): Promise<void> };

// The HTTP server is synchronous to construct; session discovery and recovery finish before a route responds.
export function createDaemon(options: DaemonOptions = {}): Daemon {
	const cwd = options.cwd ?? process.cwd();
	const manager = (async () => {
		const projectRoot = options.projectRoot ?? (await canonicalProjectRoot(cwd));
		const registry = new Registry({
			cwd,
			store: new SessionStore({ baseDir: options.sessionDir, projectRoot }),
			harnessFactory: options.harnessFactory ?? createConfiguredHarness,
			eventTailSize: options.eventTailSize ?? DEFAULT_EVENT_TAIL_SIZE,
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
	cwd: string;
	store: SessionStore;
	harnessFactory: (state: Engine.HarnessState) => Harness;
	eventTailSize: number;
}

interface InternalQueueItem {
	item: Protocol.QueueItem;
	text: string;
	placement: Protocol.Placement["type"];
	targetTurnId?: Protocol.TurnId;
}

interface ActiveTurn {
	item: InternalQueueItem;
	initial: Engine.UserMessage;
	pending: Engine.UserMessage[];
	steering: Engine.UserMessage[];
	accepting: boolean;
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
	messages: Protocol.AssistantMessage[];
	active?: Protocol.ActiveAssistantMessage;
	turns: Map<Protocol.TurnId, Protocol.TurnTerminalReason>;
	epoch: string;
	sequence: number;
	tail: Protocol.EventEnvelope[];
	subscribers: Set<ServerResponse>;
	activeTurn?: ActiveTurn;
}

class Registry {
	readonly #cwd: string;
	readonly #store: SessionStore;
	readonly #harnessFactory: (state: Engine.HarnessState) => Harness;
	readonly #eventTailSize: number;
	readonly #stored = new Map<Protocol.SessionId, StoredSession>();
	readonly #states = new Map<Protocol.SessionId, Promise<SessionState>>();
	readonly #items = new Map<Protocol.QueueItemId, InternalQueueItem>();
	#queue: Protocol.ProjectQueueSnapshot = { revision: 0, waiting: [] };
	#queueLock = Promise.resolve();
	#stopping = false;

	constructor(options: RegistryOptions) {
		this.#cwd = options.cwd;
		this.#store = options.store;
		this.#harnessFactory = options.harnessFactory;
		this.#eventTailSize = options.eventTailSize;
	}

	async initialize(): Promise<void> {
		const sessions = await this.#store.loadAll();
		for (const stored of sessions) {
			this.#stored.set(stored.session.id, stored);
			for (const record of stored.records) {
				if (record.type !== "event") continue;
				if (record.event.type === "message_submitted" && record.event.admission !== "added_to_running") {
					this.#items.set(record.event.queueItemId, {
						item: {
							id: record.event.queueItemId,
							sessionId: record.event.sessionId,
							turnId: record.event.turnId,
							messageId: record.event.messageId,
							text: record.event.text,
							state: record.event.admission === "running" ? "running" : "waiting",
							submittedAt: record.at,
						},
						text: record.event.text,
						placement: record.event.placement,
						targetTurnId: record.event.targetTurnId,
					});
				}
				if (record.event.type === "queue_changed" && record.event.queue.revision > this.#queue.revision) {
					this.#queue = cloneQueue(record.event.queue);
				}
			}
		}
		const running = this.#queue.running ? this.#items.get(this.#queue.running.id) : undefined;
		if (running && this.#queue.running) {
			running.item = {
				...running.item,
				state: this.#queue.running.state === "cancelling" ? "cancelling" : "running",
			};
		}
		this.#queue = {
			revision: this.#queue.revision,
			running: running?.item,
			waiting: this.#queue.waiting.flatMap((item) => {
				const restored = this.#items.get(item.id)?.item;
				return restored ? [{ ...restored, state: "waiting" as const }] : [];
			}),
		};
		if (this.#queue.running) await this.#recoverRunning(this.#queue.running);
		await this.#startNext();
	}

	listUnreadableSessions(): Protocol.UnreadableSession[] {
		return this.#store.unreadableSessions.map((session) => ({ ...session }));
	}

	unreadableSession(sessionId: Protocol.SessionId): Protocol.UnreadableSession | undefined {
		const session = this.#store.unreadableSessions.find((candidate) => candidate.id === sessionId);
		return session ? { ...session } : undefined;
	}

	async createSession(): Promise<Protocol.SessionDescriptor> {
		const stored = await this.#store.create(this.#cwd);
		this.#stored.set(stored.session.id, stored);
		return stored.session;
	}

	listSessions(): Protocol.SessionDescriptor[] {
		return [...this.#stored.values()]
			.map((stored) => ({ ...stored.session }))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	queue(): Protocol.ProjectQueueSnapshot {
		return cloneQueue(this.#queue);
	}

	async snapshot(sessionId: Protocol.SessionId): Promise<Protocol.SessionSnapshot | undefined> {
		if (!this.#stored.has(sessionId)) return undefined;
		const state = await this.#state(sessionId);
		const turns = new Map<Protocol.TurnId, Protocol.TurnSnapshot>();
		for (const [id, status] of state.turns) turns.set(id, { id, status });
		if (this.#queue.running?.sessionId === sessionId) {
			turns.set(this.#queue.running.turnId, {
				id: this.#queue.running.turnId,
				status: this.#queue.running.state === "cancelling" ? "cancelling" : "running",
			});
		}
		for (const item of this.#queue.waiting) {
			if (item.sessionId === sessionId) turns.set(item.turnId, { id: item.turnId, status: "waiting" });
		}
		return {
			session: { ...state.stored.session },
			identity: state.identity,
			entries: state.stored.records
				.filter((record): record is ConversationRecord => record.type === "conversation")
				.map(toConversationEntry),
			messages: state.messages.map((message) => ({ ...message })),
			active: state.active ? { ...state.active } : undefined,
			turns: [...turns.values()],
			queue: cloneQueue(this.#queue),
			cursor: { epoch: state.epoch, sequence: state.sequence },
		};
	}

	async subscribe(
		sessionId: Protocol.SessionId,
		cursor: Protocol.Cursor,
	): Promise<{ state: SessionState; replay: Protocol.EventEnvelope[] } | "missing" | "resync"> {
		if (!this.#stored.has(sessionId)) return "missing";
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
		placement: Protocol.Placement,
	): Promise<Protocol.PromptAdmission | "missing" | "turn_unavailable"> {
		return this.#withQueueLock(async () => {
			if (!this.#stored.has(sessionId)) return "missing";
			const state = await this.#state(sessionId);
			if (placement.type === "running_turn") {
				const running = this.#queue.running;
				const active = state.activeTurn;
				if (
					!running ||
					running.sessionId !== sessionId ||
					running.turnId !== placement.turnId ||
					!active ||
					active.item.item.id !== running.id ||
					!active.accepting
				) {
					return "turn_unavailable";
				}
				const message: Engine.UserMessage = {
					sessionId,
					turnId: running.turnId,
					messageId: randomUUID(),
					text,
				};
				active.pending.push(message);
				active.steering.push(message);
				await this.#appendAndPublish(state, [
					{
						type: "event",
						event: {
							actor: "human",
							sessionId,
							turnId: running.turnId,
							type: "message_submitted",
							messageId: message.messageId,
							queueItemId: running.id,
							text,
							placement: placement.type,
							targetTurnId: placement.turnId,
							admission: "added_to_running",
						},
					},
				]);
				return {
					status: "added_to_running",
					sessionId,
					turnId: running.turnId,
					messageId: message.messageId,
					queueItemId: running.id,
					queue: cloneQueue(this.#queue),
				};
			}

			if (placement.type === "after_turn") {
				const running = this.#queue.running;
				if (!running || running.sessionId !== sessionId || running.turnId !== placement.turnId) {
					return "turn_unavailable";
				}
			}

			const messageId = randomUUID();
			const turnId = randomUUID();
			const queueItemId = randomUUID();
			const status: Protocol.AdmissionStatus = this.#queue.running ? "waiting" : "running";
			const item: InternalQueueItem = {
				item: {
					id: queueItemId,
					sessionId,
					turnId,
					messageId,
					text,
					state: status,
					submittedAt: new Date().toISOString(),
				},
				text,
				placement: placement.type,
				targetTurnId: placement.type === "after_turn" ? placement.turnId : undefined,
			};
			this.#items.set(queueItemId, item);
			if (status === "running") this.#queue.running = item.item;
			if (status === "waiting") this.#insertWaiting(item);
			this.#queue.revision++;
			await this.#appendAndPublish(state, [
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
						placement: placement.type,
						targetTurnId: placement.type === "after_turn" ? placement.turnId : undefined,
						admission: status,
					},
				},
			]);
			await this.#publishQueue();
			if (status === "running") this.#start(item, state);
			return {
				status,
				sessionId,
				turnId,
				messageId,
				queueItemId,
				queue: cloneQueue(this.#queue),
			};
		});
	}

	async cancel(
		sessionId: Protocol.SessionId,
		turnId: Protocol.TurnId,
	): Promise<Protocol.TurnCancellationResult | "missing" | "turn_unavailable"> {
		return this.#withQueueLock(async () => {
			if (!this.#stored.has(sessionId)) return "missing";
			const state = await this.#state(sessionId);
			const terminal = state.turns.get(turnId);
			if (terminal === "aborted" || terminal === "cancelled") {
				return { status: terminal, sessionId, turnId };
			}
			if (terminal) return "turn_unavailable";

			const running = this.#queue.running;
			if (running?.sessionId === sessionId && running.turnId === turnId) {
				if (running.state === "cancelling") return { status: "cancelling", sessionId, turnId };
				const active = state.activeTurn;
				if (!active || active.terminal) return "turn_unavailable";
				active.accepting = false;
				active.cancellationRequested = true;
				const cancelling = { ...running, state: "cancelling" as const };
				active.item.item = cancelling;
				this.#queue.running = cancelling;
				this.#queue.revision++;
				await this.#appendAndPublish(state, [
					{
						type: "event",
						event: { actor: "human", sessionId, turnId, type: "turn_cancel_requested" },
					},
					this.#queueChangedPayload(sessionId),
				]);
				await this.#publishQueue(sessionId);
				active.controller.abort();
				return { status: "cancelling", sessionId, turnId };
			}
			const index = this.#queue.waiting.findIndex((item) => item.sessionId === sessionId && item.turnId === turnId);
			if (index === -1) return "turn_unavailable";
			const [removed] = this.#queue.waiting.splice(index, 1);
			const internal = this.#items.get(removed.id);
			if (!internal) return "turn_unavailable";
			this.#queue.revision++;
			await this.#appendAndPublish(state, [
				{
					type: "event",
					event: { actor: "human", sessionId, turnId, type: "turn_cancel_requested" },
				},
				{
					type: "event",
					event: {
						actor: "process",
						sessionId,
						turnId,
						type: "message_undelivered",
						messageId: removed.messageId,
						text: internal.text,
						reason: "cancelled",
					},
				},
				{ type: "event", event: { actor: "process", sessionId, turnId, type: "cancelled" } },
				{
					type: "event",
					event: { actor: "process", sessionId, turnId, type: "turn_terminal", reason: "cancelled" },
				},
				{ type: "event", event: { actor: "process", sessionId, turnId, type: "end" } },
				this.#queueChangedPayload(sessionId),
			]);
			await this.#publishQueue(sessionId);
			return { status: "cancelled", sessionId, turnId };
		});
	}

	heartbeat(): void {
		for (const statePromise of this.#states.values()) {
			void statePromise.then((state) => {
				for (const res of state.subscribers) {
					if (!res.destroyed) res.write(": hb\n\n");
				}
			});
		}
	}

	async shutdown(): Promise<void> {
		this.#stopping = true;
		const running = this.#queue.running;
		if (!running) return;
		const state = await this.#state(running.sessionId);
		const active = state.activeTurn;
		if (!active) return;
		active.accepting = false;
		active.controller.abort();
		await active.done.promise;
	}

	async #state(sessionId: Protocol.SessionId): Promise<SessionState> {
		const existing = this.#states.get(sessionId);
		if (existing) return existing;
		const stored = this.#stored.get(sessionId);
		if (!stored) throw new Error(`Unknown session ${sessionId}`);
		const loading = Promise.resolve(this.#loadState(stored));
		this.#states.set(sessionId, loading);
		return loading;
	}

	#loadState(stored: StoredSession): SessionState {
		const conversation = stored.records.filter(
			(record): record is ConversationRecord => record.type === "conversation",
		);
		const identity = stored.records.findLast(
			(record): record is IdentityRecord => record.type === "identity",
		)?.identity;
		const messages = stored.records
			.filter((record): record is AssistantRecord => record.type === "assistant")
			.map((record) => ({ ...record.message }));
		const turns = new Map<Protocol.TurnId, Protocol.TurnTerminalReason>();
		for (const record of stored.records) {
			if (record.type !== "event") continue;
			const event = record.event;
			if (event.type === "turn_terminal") turns.set(event.turnId, event.reason);
		}
		const state: Engine.HarnessState = {
			messages: conversation.map((record) => record.message),
			identity,
		};
		return {
			stored,
			harness: this.#harnessFactory(state),
			persistedMessageCount: state.messages.length,
			lastConversationEntryId: conversation.at(-1)?.id ?? null,
			identity,
			messages,
			turns,
			epoch: randomUUID(),
			sequence: 0,
			tail: [],
			subscribers: new Set(),
		};
	}

	#insertWaiting(item: InternalQueueItem): void {
		if (item.placement !== "after_turn" || !item.targetTurnId) {
			this.#queue.waiting.push({ ...item.item, state: "waiting" });
			return;
		}
		const index = this.#queue.waiting.findLastIndex((queued) => {
			const internal = this.#items.get(queued.id);
			return internal?.placement === "after_turn" && internal.targetTurnId === item.targetTurnId;
		});
		this.#queue.waiting.splice(index + 1, 0, { ...item.item, state: "waiting" });
	}

	#start(item: InternalQueueItem, state: SessionState): void {
		const initial: Engine.UserMessage = {
			sessionId: item.item.sessionId,
			turnId: item.item.turnId,
			messageId: item.item.messageId,
			text: item.text,
		};
		const turn: ActiveTurn = {
			item,
			initial,
			pending: [initial],
			steering: [],
			accepting: true,
			controller: new AbortController(),
			done: Promise.withResolvers<void>(),
			terminal: false,
			cancellationRequested: false,
		};
		state.activeTurn = turn;
		void this.#runTurn(state, turn);
	}

	async #runTurn(state: SessionState, turn: ActiveTurn): Promise<void> {
		let failureReason: "aborted" | "error" | undefined;
		try {
			for await (const event of state.harness.send(
				{
					initial: turn.initial,
					takeSteering: (closeIfEmpty) => {
						const message = turn.steering.shift();
						if (message) return message;
						if (closeIfEmpty) turn.accepting = false;
						return undefined;
					},
				},
				turn.controller.signal,
			)) {
				if (turn.terminal) continue;
				if (event.type === "message_delivered") {
					const index = turn.pending.findIndex((message) => message.messageId === event.messageId);
					if (index !== -1) turn.pending.splice(index, 1);
				}
				if (event.type === "aborted") {
					turn.accepting = false;
					failureReason = "aborted";
				}
				if (event.type === "error") {
					turn.accepting = false;
					failureReason = "error";
				}
				if (event.type === "end") {
					if (turn.cancellationRequested && failureReason !== "aborted") {
						failureReason = "aborted";
						await this.#recordHarnessEvent(state, {
							actor: "process",
							sessionId: turn.initial.sessionId,
							turnId: turn.initial.turnId,
							type: "aborted",
						});
					}
					await this.#finishTurn(state, turn, failureReason);
					break;
				}
				await this.#recordHarnessEvent(state, event);
			}
		} catch (error) {
			turn.accepting = false;
			if (!failureReason && turn.controller.signal.aborted) {
				failureReason = "aborted";
				await this.#recordHarnessEvent(state, {
					actor: "process",
					sessionId: turn.initial.sessionId,
					turnId: turn.initial.turnId,
					type: "aborted",
				});
			}
			if (!failureReason) {
				failureReason = "error";
				await this.#recordHarnessEvent(state, {
					actor: "process",
					sessionId: turn.initial.sessionId,
					turnId: turn.initial.turnId,
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (!turn.terminal) {
				if (turn.cancellationRequested && failureReason !== "aborted") {
					failureReason = "aborted";
					await this.#recordHarnessEvent(state, {
						actor: "process",
						sessionId: turn.initial.sessionId,
						turnId: turn.initial.turnId,
						type: "aborted",
					});
				}
				await this.#finishTurn(state, turn, failureReason ?? "error");
			}
			if (state.activeTurn === turn) state.activeTurn = undefined;
			await this.#withQueueLock(async () => {
				if (this.#queue.running?.id !== turn.item.item.id) return;
				this.#queue.running = undefined;
				this.#queue.revision++;
				await this.#publishQueue();
				if (!this.#stopping) await this.#startNext();
			});
			turn.done.resolve();
		}
	}

	async #finishTurn(state: SessionState, turn: ActiveTurn, failureReason?: "aborted" | "error"): Promise<void> {
		turn.accepting = false;
		const scope = { sessionId: turn.initial.sessionId, turnId: turn.initial.turnId };
		const reason = failureReason ?? (turn.pending.length > 0 || state.active ? "error" : "completed");
		if (!failureReason && reason === "error") {
			await this.#recordHarnessEvent(state, {
				actor: "process",
				...scope,
				type: "error",
				message: "The turn ended before all submitted input and model output became terminal",
			});
		}
		for (const message of turn.pending) {
			const undeliveredReason = reason === "completed" ? "error" : reason;
			await this.#recordHarnessEvent(state, {
				actor: "process",
				...scope,
				type: "message_undelivered",
				messageId: message.messageId,
				text: message.text,
				reason: undeliveredReason,
			});
		}
		turn.pending.length = 0;
		turn.steering.length = 0;
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
		if (event.type === "turn_terminal") state.turns.set(event.turnId, event.reason);
	}

	async #publishQueue(excludedSessionId?: Protocol.SessionId): Promise<void> {
		const loaded = await Promise.all(this.#states.values());
		for (const state of loaded) {
			if (state.stored.session.id === excludedSessionId) continue;
			await this.#appendAndPublish(state, [this.#queueChangedPayload(state.stored.session.id)]);
		}
	}

	#queueChangedPayload(sessionId: Protocol.SessionId): Extract<Payload, { type: "event" }> {
		return {
			type: "event",
			event: {
				actor: "process",
				sessionId,
				type: "queue_changed",
				queue: cloneQueue(this.#queue),
			},
		};
	}

	async #recoverRunning(item: Protocol.QueueItem): Promise<void> {
		const state = await this.#state(item.sessionId);
		const scope = { sessionId: item.sessionId, turnId: item.turnId };
		const cancellation = item.state === "cancelling";
		if (state.turns.has(item.turnId)) {
			const hasEnd = state.stored.records.some(
				(record) => record.type === "event" && record.event.type === "end" && record.event.turnId === item.turnId,
			);
			if (!hasEnd) {
				await this.#appendAndPublish(state, [{ type: "event", event: { actor: "process", ...scope, type: "end" } }]);
			}
			this.#queue.running = undefined;
			this.#queue.revision++;
			await this.#publishQueue();
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
		state.harness = this.#harnessFactory({ messages: nextHistory, identity: history.identity });
		state.persistedMessageCount = nextHistory.length;
		this.#queue.running = undefined;
		this.#queue.revision++;
		await this.#publishQueue();
	}

	async #startNext(): Promise<void> {
		if (this.#stopping || this.#queue.running || this.#queue.waiting.length === 0) return;
		const next = this.#queue.waiting[0];
		if (!next) return;
		const item = this.#items.get(next.id);
		if (!item) throw new Error(`Queue item ${next.id} has no submitted prompt`);
		const state = await this.#state(item.item.sessionId);
		this.#queue.waiting.shift();
		item.item = { ...item.item, state: "running" };
		this.#queue.running = item.item;
		this.#queue.revision++;
		await this.#publishQueue();
		this.#start(item, state);
	}

	#withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
		const running = this.#queueLock.then(operation, operation);
		this.#queueLock = running.then(
			() => undefined,
			() => undefined,
		);
		return running;
	}
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
			writeJson(res, 201, await manager.createSession());
			return;
		}
		if (req.method === "GET" && url.pathname === "/sessions") {
			writeJson(res, 200, {
				sessions: manager.listSessions(),
				unreadable: manager.listUnreadableSessions(),
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/queue") {
			writeJson(res, 200, manager.queue());
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
			const admitted = await manager.admit(sessionId, prompt.text, prompt.placement);
			if (admitted === "missing") {
				res.writeHead(404).end();
				return;
			}
			if (admitted === "turn_unavailable") {
				writeJson(res, 409, { code: "turn_unavailable" });
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
		toolCalls: (record.message.toolCalls ?? []).map((call) => ({
			id: call.callId,
			name: call.name,
			arguments: call.arguments,
		})),
	};
}

function createConfiguredHarness(state: Engine.HarnessState): Harness {
	const config = Config.loadConfig();
	return Engine.createHarness(
		{
			model: config.model,
			getAuth: (signal) => Auth.resolveAuth(config.apiKey, signal),
			tools: Agent.tools,
			systemPrompt: Agent.systemPrompt,
			reasoningEffort: config.reasoningEffort,
		},
		undefined,
		state,
	);
}

interface PromptRequest {
	text: string;
	placement: Protocol.Placement;
}

function parsePromptRequest(value: unknown): PromptRequest | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("text" in value) ||
		typeof value.text !== "string" ||
		value.text.trim() === ""
	) {
		return undefined;
	}
	const placement = "placement" in value ? value.placement : undefined;
	if (placement === undefined || placement === "end") {
		return { text: value.text, placement: { type: "end" } };
	}
	if (
		(placement === "after_turn" || placement === "running_turn") &&
		"turnId" in value &&
		typeof value.turnId === "string"
	) {
		return { text: value.text, placement: { type: placement, turnId: value.turnId } };
	}
	return undefined;
}

function cloneQueue(queue: Protocol.ProjectQueueSnapshot): Protocol.ProjectQueueSnapshot {
	return {
		revision: queue.revision,
		running: queue.running ? { ...queue.running } : undefined,
		waiting: queue.waiting.map((item) => ({ ...item })),
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
