import { randomUUID } from "node:crypto";
import type * as Protocol from "@ker-ai/protocol";
import type { CompactionRecord, ConversationRecord, StoredRecord } from "@ker-ai/store";

export class SessionProjection {
	readonly session: Protocol.SessionDescriptor;
	readonly #eventTailSize: number;
	readonly #epoch = randomUUID();
	readonly #subscribers = new Set<(envelope: Protocol.EventEnvelope) => void>();
	readonly #entries: Protocol.ConversationEntry[] = [];
	readonly #messages: Protocol.AssistantMessage[] = [];
	readonly #messageIds = new Set<Protocol.MessageId>();
	readonly #turns = new Map<Protocol.TurnId, Protocol.TurnTerminalReason>();
	readonly #automaticCompactions = new Set<Protocol.TurnId>();
	readonly #tail: Protocol.EventEnvelope[] = [];
	#identity?: Protocol.Identity;
	#model?: Protocol.Model;
	#contextTokens = 0;
	#cumulativeUsage: Protocol.Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	#compactionFailure?: Protocol.CompactionFailure;
	#active?: Protocol.ActiveAssistantMessage;
	#queue: Protocol.QueueSnapshot = { revision: 0, waiting: [] };
	#sequence = 0;
	#firstUserText?: string;

	private constructor(session: Protocol.SessionDescriptor, eventTailSize: number) {
		this.session = { ...session };
		this.#eventTailSize = eventTailSize;
	}

	static load(records: StoredRecord[], eventTailSize: number): SessionProjection {
		const first = records[0];
		if (!first || first.type !== "session") throw new Error("Session log has no session record");
		const projection = new SessionProjection(first.session, eventTailSize);
		for (const record of records) projection.#applyRecord(record, false);
		return projection;
	}

	apply(records: StoredRecord[]): void {
		for (const record of records) this.#applyRecord(record, true);
	}

	applyDelta(event: Protocol.TurnEvent): void {
		if (event.type !== "message_delta" && event.type !== "reasoning_delta") return;
		if (event.type === "message_delta") this.#applyMessageDelta(event);
		this.#publish(event);
	}

	snapshot(): Protocol.SessionSnapshot {
		const turns = new Map<Protocol.TurnId, Protocol.TurnSnapshot>();
		for (const [id, status] of this.#turns) turns.set(id, { id, status });
		if (this.#queue.running) {
			turns.set(this.#queue.running.turnId, {
				id: this.#queue.running.turnId,
				status: this.#queue.running.state === "cancelling" ? "cancelling" : "running",
			});
		}
		for (const item of this.#queue.waiting) turns.set(item.turnId, { id: item.turnId, status: "waiting" });
		return {
			session: { ...this.session },
			identity: this.#identity,
			model: this.#model ? { ...this.#model } : undefined,
			usage: { contextTokens: this.#contextTokens, cumulative: { ...this.#cumulativeUsage } },
			compactionFailure: this.#compactionFailure ? { ...this.#compactionFailure } : undefined,
			entries: this.#entries.map((entry) => structuredClone(entry)),
			messages: this.#messages.map((message) => ({ ...message })),
			active: this.#active ? { ...this.#active } : undefined,
			turns: [...turns.values()],
			queue: cloneQueue(this.#queue),
			cursor: { epoch: this.#epoch, sequence: this.#sequence },
		};
	}

	subscribe(
		cursor: Protocol.Cursor,
		listener: (envelope: Protocol.EventEnvelope) => void,
	): { replay: Protocol.EventEnvelope[]; unsubscribe: () => void } | "resync" {
		const firstSequence = this.#tail[0]?.sequence ?? this.#sequence + 1;
		if (cursor.epoch !== this.#epoch || cursor.sequence > this.#sequence || cursor.sequence < firstSequence - 1) {
			return "resync";
		}
		this.#subscribers.add(listener);
		return {
			replay: this.#tail.filter((envelope) => envelope.sequence > cursor.sequence),
			unsubscribe: () => this.#subscribers.delete(listener),
		};
	}

	status(): "idle" | "busy" {
		return this.#queue.running || this.#queue.waiting.length > 0 ? "busy" : "idle";
	}

	firstUserText(): string | undefined {
		return this.#firstUserText;
	}

	#applyRecord(record: StoredRecord, publish: boolean): void {
		this.session.updatedAt = record.at;
		if (record.type === "session") Object.assign(this.session, record.session);
		if (record.type === "identity") this.#identity = record.identity;
		if (record.type === "stats") {
			this.#contextTokens = record.contextTokens;
			this.#model = record.model ?? undefined;
		}
		if (record.type === "conversation") this.#entries.push(toConversationEntry(record));
		if (record.type === "compaction") this.#entries.push(toCompactionEntry(record));
		if (record.type === "assistant") {
			this.#messages.push({ ...record.message });
			this.#messageIds.add(record.message.id);
			if (this.#active?.id === record.message.id) this.#active = undefined;
		}
		if (record.type !== "event") return;
		this.#applyEvent(record.event);
		if (publish) this.#publish(record.event);
	}

	#applyEvent(event: Protocol.Event): void {
		if (event.type === "message_submitted") this.#firstUserText ??= event.text;
		if (event.type === "message_delta") this.#applyMessageDelta(event);
		if (event.type === "usage") this.#cumulativeUsage = addUsage(this.#cumulativeUsage, event.usage);
		if (event.type === "turn_terminal") this.#turns.set(event.turnId, event.reason);
		if (event.type === "queue_changed" && event.queue.revision > this.#queue.revision) {
			this.#queue = normalizeQueue(event.queue);
		}
		if (event.type === "compaction_submitted" && event.source === "auto") {
			this.#automaticCompactions.add(event.turnId);
		}
		if (event.type === "error" && this.#automaticCompactions.has(event.turnId)) {
			this.#compactionFailure = { turnId: event.turnId, message: event.message };
		}
		if (event.type === "compacted") this.#compactionFailure = undefined;
	}

	#applyMessageDelta(event: Protocol.MessageDeltaEvent): void {
		if (this.#messageIds.has(event.messageId)) return;
		const active = this.#active?.id === event.messageId ? this.#active : undefined;
		if (!active) {
			this.#active = { id: event.messageId, turnId: event.turnId, text: event.text };
			return;
		}
		if (event.offset !== active.text.length) throw new Error(`Non-contiguous assistant message ${event.messageId}`);
		active.text += event.text;
	}

	#publish(event: Protocol.Event): void {
		const envelope: Protocol.EventEnvelope = { epoch: this.#epoch, sequence: ++this.#sequence, event };
		this.#tail.push(envelope);
		if (this.#tail.length > this.#eventTailSize) this.#tail.shift();
		for (const listener of this.#subscribers) listener(envelope);
	}
}

function toConversationEntry(record: ConversationRecord): Protocol.ConversationEntry {
	const base = { id: record.id, parentId: record.parentId, turnId: record.turnId, messageId: record.messageId };
	if (record.message.role === "user" || record.message.role === "developer") {
		return { ...base, role: record.message.role, content: record.message.content };
	}
	if (record.message.role === "tool") {
		return {
			...base,
			role: "tool",
			toolCallId: record.message.toolCallId,
			content: record.message.content,
			status: record.message.status,
			...(record.message.details === undefined ? {} : { details: record.message.details }),
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
