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
	send(input: Engine.UserMessage, signal?: AbortSignal): AsyncIterable<Protocol.TurnEvent>;
	snapshot(): Engine.HarnessState;
}

export interface DaemonOptions {
	harnessFactory?: (state: Engine.HarnessState, cwd: string) => Harness;
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
	harnessFactory: (state: Engine.HarnessState, cwd: string) => Harness;
	eventTailSize: number;
}

interface ActiveTurn {
	item: Protocol.QueueItem;
	message: Engine.UserMessage;
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
}

class Registry {
	readonly #cwd: string;
	readonly #store: SessionStore;
	readonly #harnessFactory: (state: Engine.HarnessState, cwd: string) => Harness;
	readonly #eventTailSize: number;
	readonly #stored = new Map<Protocol.SessionId, StoredSession>();
	readonly #states = new Map<Protocol.SessionId, Promise<SessionState>>();
	#stopping = false;

	constructor(options: RegistryOptions) {
		this.#cwd = options.cwd;
		this.#store = options.store;
		this.#harnessFactory = options.harnessFactory;
		this.#eventTailSize = options.eventTailSize;
	}

	async initialize(): Promise<void> {
		const sessions = await this.#store.loadAll();
		for (const stored of sessions) this.#stored.set(stored.session.id, stored);
		const states = await Promise.all(sessions.map((stored) => this.#state(stored.session.id)));
		await Promise.all(
			states.map((state) =>
				this.#withQueueLock(state, async () => {
					if (state.queue.running) {
						await this.#recoverRunning(state, state.queue.running);
						return;
					}
					await this.#startNext(state);
				}),
			),
		);
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

	async snapshot(sessionId: Protocol.SessionId): Promise<Protocol.SessionSnapshot | undefined> {
		if (!this.#stored.has(sessionId)) return undefined;
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
				entries: state.stored.records
					.filter((record): record is ConversationRecord => record.type === "conversation")
					.map(toConversationEntry),
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
		if (!this.#stored.has(sessionId)) return "missing";
		const state = await this.#state(sessionId);
		const firstSequence = state.tail[0]?.sequence ?? state.sequence + 1;
		if (cursor.epoch !== state.epoch || cursor.sequence > state.sequence || cursor.sequence < firstSequence - 1) {
			return "resync";
		}
		return { state, replay: state.tail.filter((envelope) => envelope.sequence > cursor.sequence) };
	}

	async admit(sessionId: Protocol.SessionId, text: string): Promise<Protocol.PromptAdmission | "missing"> {
		if (!this.#stored.has(sessionId)) return "missing";
		const state = await this.#state(sessionId);
		return this.#withQueueLock(state, async () => {
			const messageId = randomUUID();
			const turnId = randomUUID();
			const queueItemId = randomUUID();
			const status: Protocol.AdmissionStatus = state.queue.running || this.#stopping ? "waiting" : "running";
			const item: Protocol.QueueItem = {
				id: queueItemId,
				turnId,
				messageId,
				text,
				state: status,
				submittedAt: new Date().toISOString(),
			};
			state.items.set(queueItemId, item);
			if (status === "running") state.queue.running = item;
			if (status === "waiting") state.queue.waiting.push(item);
			state.queue.revision++;
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
						admission: status,
					},
				},
				this.#queueChangedPayload(state),
			]);
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

	async cancel(
		sessionId: Protocol.SessionId,
		turnId: Protocol.TurnId,
	): Promise<Protocol.TurnCancellationResult | "missing" | "turn_unavailable"> {
		if (!this.#stored.has(sessionId)) return "missing";
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
						text: removed.text,
						reason: "cancelled",
					},
				},
				{ type: "event", event: { actor: "process", sessionId, turnId, type: "cancelled" } },
				{
					type: "event",
					event: { actor: "process", sessionId, turnId, type: "turn_terminal", reason: "cancelled" },
				},
				{ type: "event", event: { actor: "process", sessionId, turnId, type: "end" } },
				this.#queueChangedPayload(state),
			]);
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
		const states = await Promise.all(this.#states.values());
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
					messageId: event.messageId,
					text: event.text,
					state: event.admission,
					submittedAt: record.at,
				});
			}
			if (event.type === "queue_changed" && event.queue.revision > queue.revision) queue = cloneQueue(event.queue);
		}
		const running = queue.running ? items.get(queue.running.id) : undefined;
		const restoredRunning: Protocol.QueueItem | undefined =
			running && queue.running
				? { ...running, state: queue.running.state === "cancelling" ? "cancelling" : "running" }
				: undefined;
		if (restoredRunning) items.set(restoredRunning.id, restoredRunning);
		const waiting = queue.waiting.flatMap((queued) => {
			const item = items.get(queued.id);
			if (!item) return [];
			const restored = { ...item, state: "waiting" as const };
			items.set(restored.id, restored);
			return [restored];
		});
		const state: Engine.HarnessState = {
			messages: conversation.map((record) => record.message),
			identity,
		};
		return {
			stored,
			harness: this.#harnessFactory(state, stored.session.cwd),
			persistedMessageCount: state.messages.length,
			lastConversationEntryId: conversation.at(-1)?.id ?? null,
			identity,
			messages,
			turns,
			epoch: randomUUID(),
			sequence: 0,
			tail: [],
			subscribers: new Set(),
			items,
			queue: { revision: queue.revision, running: restoredRunning, waiting },
			queueLock: Promise.resolve(),
		};
	}

	#start(item: Protocol.QueueItem, state: SessionState): void {
		const message: Engine.UserMessage = {
			sessionId: state.stored.session.id,
			turnId: item.turnId,
			messageId: item.messageId,
			text: item.text,
		};
		const turn: ActiveTurn = {
			item,
			message,
			delivered: false,
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
			for await (const event of state.harness.send(turn.message, turn.controller.signal)) {
				if (turn.terminal) continue;
				if (event.type === "message_delivered" && event.messageId === turn.message.messageId) turn.delivered = true;
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
					sessionId: turn.message.sessionId,
					turnId: turn.message.turnId,
					type: "aborted",
				});
			}
			if (!failureReason) {
				failureReason = "error";
				await this.#recordHarnessEvent(state, {
					actor: "process",
					sessionId: turn.message.sessionId,
					turnId: turn.message.turnId,
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

	async #completeTurn(state: SessionState, turn: ActiveTurn, failureReason?: "aborted" | "error"): Promise<void> {
		await this.#withQueueLock(state, async () => {
			if (state.activeTurn !== turn || turn.terminal) return;
			const aborted = turn.cancellationRequested || turn.controller.signal.aborted;
			const finalFailure = aborted ? "aborted" : failureReason;
			if (aborted && failureReason !== "aborted") {
				await this.#recordHarnessEvent(state, {
					actor: "process",
					sessionId: turn.message.sessionId,
					turnId: turn.message.turnId,
					type: "aborted",
				});
			}
			await this.#finishTurn(state, turn, finalFailure);
			state.activeTurn = undefined;
			await this.#advanceQueue(state, turn.item.id);
		});
	}

	async #finishTurn(state: SessionState, turn: ActiveTurn, failureReason?: "aborted" | "error"): Promise<void> {
		const scope = { sessionId: turn.message.sessionId, turnId: turn.message.turnId };
		const reason = failureReason ?? (!turn.delivered || state.active ? "error" : "completed");
		if (!failureReason && reason === "error") {
			await this.#recordHarnessEvent(state, {
				actor: "process",
				...scope,
				type: "error",
				message: "The turn ended before all submitted input and model output became terminal",
			});
		}
		if (!turn.delivered) {
			const undeliveredReason = reason === "completed" ? "error" : reason;
			await this.#recordHarnessEvent(state, {
				actor: "process",
				...scope,
				type: "message_undelivered",
				messageId: turn.message.messageId,
				text: turn.message.text,
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
		const next = this.#stopping ? undefined : state.queue.waiting.shift();
		const item = next ? state.items.get(next.id) : undefined;
		if (next && !item) throw new Error(`Queue item ${next.id} has no submitted prompt`);
		const running = item ? { ...item, state: "running" as const } : undefined;
		if (running) state.items.set(running.id, running);
		state.queue.running = running;
		state.queue.revision++;
		await this.#appendAndPublish(state, [this.#queueChangedPayload(state)]);
		if (running) this.#start(running, state);
	}

	async #startNext(state: SessionState): Promise<void> {
		if (this.#stopping || state.queue.running || state.queue.waiting.length === 0) return;
		const next = state.queue.waiting.shift();
		if (!next) return;
		const item = state.items.get(next.id);
		if (!item) throw new Error(`Queue item ${next.id} has no submitted prompt`);
		const running = { ...item, state: "running" as const };
		state.items.set(running.id, running);
		state.queue.running = running;
		state.queue.revision++;
		await this.#appendAndPublish(state, [this.#queueChangedPayload(state)]);
		this.#start(running, state);
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

function createConfiguredHarness(state: Engine.HarnessState, cwd: string): Harness {
	const config = Config.loadConfig();
	const definition = Agent.createDefinition(cwd);
	return Engine.createHarness(
		{
			model: config.model,
			getAuth: (signal) => Auth.resolveAuth(config.apiKey, signal),
			tools: definition.tools,
			systemPrompt: definition.systemPrompt,
			reasoningEffort: config.reasoningEffort,
		},
		undefined,
		state,
	);
}

interface PromptRequest {
	text: string;
}

function parsePromptRequest(value: unknown): PromptRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prompt = value as Record<string, unknown>;
	if (Object.keys(prompt).length !== 1 || typeof prompt.text !== "string" || prompt.text.trim() === "") {
		return undefined;
	}
	return { text: prompt.text };
}

function cloneQueue(queue: Protocol.QueueSnapshot): Protocol.QueueSnapshot {
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
