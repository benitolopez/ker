import type * as Protocol from "@ker-ai/protocol";

export type Block =
	| { kind: "prompt"; key: string; text: string }
	| { kind: "answer"; key: string; text: string; done: boolean }
	| { kind: "reasoning"; key: string; text: string }
	| {
			kind: "tool";
			key: string;
			name: string;
			args: string;
			result?: { status: "ok" | "error"; output: string };
	  }
	| { kind: "notice"; key: string; text: string; tone: "info" | "error" };

export interface TranscriptHeader {
	session: Protocol.SessionDescriptor;
	model?: Protocol.Model;
	usage: Protocol.SessionUsage;
	status: Protocol.TurnSnapshot["status"] | "idle" | "error";
}

export interface TranscriptView {
	blockKeys: readonly string[];
	header?: TranscriptHeader;
	queue: Protocol.QueueSnapshot;
}

export interface BlockSnapshot {
	block?: Block;
	version: number;
}

const EMPTY_QUEUE: Protocol.QueueSnapshot = { revision: 0, waiting: [] };
const EMPTY_BLOCK: BlockSnapshot = { version: 0 };

export class TranscriptStore {
	#view: TranscriptView = { blockKeys: [], queue: EMPTY_QUEUE };
	readonly #blocks = new Map<string, BlockSnapshot>();
	readonly #listeners = new Set<() => void>();
	readonly #activityListeners = new Set<() => void>();
	readonly #blockListeners = new Map<string, Set<() => void>>();
	readonly #promptMessageIds = new Set<Protocol.MessageId>();
	readonly #messageOffsets = new Map<Protocol.MessageId, number>();
	readonly #reasoningOffsets = new Map<Protocol.MessageId, number>();
	readonly #toolCallIds = new Set<string>();
	readonly #toolKeysByCallId = new Map<string, string>();
	readonly #compactionTurnIds = new Set<Protocol.TurnId>();
	readonly #waitingCancellationTurnIds = new Set<Protocol.TurnId>();
	readonly #eventIds = new Set<string>();
	#authMode?: Protocol.AuthEvent["mode"];

	getSnapshot = (): TranscriptView => this.#view;

	getBlockSnapshot = (key: string): BlockSnapshot => this.#blocks.get(key) ?? EMPTY_BLOCK;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	subscribeActivity = (listener: () => void): (() => void) => {
		this.#activityListeners.add(listener);
		return () => this.#activityListeners.delete(listener);
	};

	subscribeBlock = (key: string, listener: () => void): (() => void) => {
		const listeners = this.#blockListeners.get(key) ?? new Set();
		listeners.add(listener);
		this.#blockListeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.#blockListeners.delete(key);
		};
	};

	reset(snapshot: Protocol.SessionSnapshot): void {
		const previousKeys = new Set(this.#blocks.keys());
		this.#blocks.clear();
		this.#promptMessageIds.clear();
		this.#messageOffsets.clear();
		this.#reasoningOffsets.clear();
		this.#toolCallIds.clear();
		this.#toolKeysByCallId.clear();
		this.#compactionTurnIds.clear();
		this.#waitingCancellationTurnIds.clear();
		this.#eventIds.clear();
		this.#authMode = undefined;
		this.#view = {
			blockKeys: [],
			header: {
				session: snapshot.session,
				model: snapshot.model,
				usage: snapshot.usage,
				status: sessionStatus(snapshot.queue),
			},
			queue: snapshot.queue,
		};
		const messages = new Map(snapshot.messages.map((message) => [message.id, message]));
		const linkedMessageIds = new Set(
			snapshot.entries.flatMap((entry) => (entry.role === "assistant" && entry.messageId ? [entry.messageId] : [])),
		);
		const pendingByTurn = new Map<
			Protocol.TurnId,
			Array<Protocol.AssistantMessage | Protocol.ActiveAssistantMessage>
		>();
		for (const message of snapshot.messages) {
			if (linkedMessageIds.has(message.id)) continue;
			pendingByTurn.set(message.turnId, [...(pendingByTurn.get(message.turnId) ?? []), message]);
		}
		if (snapshot.active) {
			pendingByTurn.set(snapshot.active.turnId, [
				...(pendingByTurn.get(snapshot.active.turnId) ?? []),
				snapshot.active,
			]);
		}
		const flush = (turnId: Protocol.TurnId) => {
			const pending = pendingByTurn.get(turnId);
			if (!pending) return;
			for (const message of pending) this.#answer(message.id, message.text, "reason" in message);
			pendingByTurn.delete(turnId);
		};

		for (const [index, entry] of snapshot.entries.entries()) {
			if (entry.role === "user") this.#prompt(entry.messageId ?? entry.id, entry.content);
			if (entry.role === "developer") {
				flush(entry.turnId);
				this.#notice(`notice:entry:${entry.id}`, entry.content, "info");
			}
			if (entry.role === "assistant") {
				if (entry.reasoningSummary) this.#reasoning(entry.messageId ?? entry.id, entry.reasoningSummary);
				const message = entry.messageId ? messages.get(entry.messageId) : undefined;
				if (message) this.#answer(message.id, message.text, true);
				if (!message && entry.content) this.#answer(entry.messageId ?? entry.id, entry.content, true);
				for (const call of entry.toolCalls) this.#tool(call.id, call.name, call.arguments);
			}
			if (entry.role === "tool") this.#toolResult(entry.toolCallId, "ok", entry.content);
			if (entry.role === "compaction") {
				flush(entry.turnId);
				this.#compactionTurnIds.add(entry.turnId);
				this.#notice(
					`notice:entry:${entry.id}`,
					`Compacted context (${formatTokens(entry.tokensBefore)} → ${formatTokens(entry.tokensAfter)} tokens)\n${entry.summary}`,
					"info",
				);
			}
			if (snapshot.entries[index + 1]?.turnId !== entry.turnId) flush(entry.turnId);
		}
		for (const turnId of pendingByTurn.keys()) flush(turnId);
		const running = snapshot.queue.running;
		if (running?.kind === "prompt") this.#prompt(running.messageId, running.text);
		if (snapshot.compactionFailure) {
			this.#notice(
				`notice:compaction-failure:${snapshot.compactionFailure.turnId}`,
				`Automatic compaction failed: ${snapshot.compactionFailure.message}`,
				"error",
			);
		}
		this.#view = { ...this.#view, blockKeys: [...this.#blocks.keys()] };
		for (const key of new Set([...previousKeys, ...this.#blocks.keys()])) this.#notifyBlock(key);
		this.#notifyView();
	}

	apply(envelope: Protocol.EventEnvelope): void {
		const eventId = `${envelope.epoch}:${envelope.sequence}`;
		if (this.#eventIds.has(eventId)) return;
		this.#eventIds.add(eventId);
		const event = envelope.event;
		if (event.type === "message_submitted" && event.admission === "running") {
			this.#prompt(event.messageId, event.text);
		}
		if (event.type === "message_delivered") this.#prompt(event.messageId, event.text);
		if (event.type === "message_undelivered" && event.reason !== "cancelled") {
			this.#notice(`notice:${eventId}`, `Prompt was not delivered: ${event.reason}\n${event.text}`, "error");
		}
		if (event.type === "message_delta") this.#appendAnswer(event.messageId, event.offset, event.text);
		if (event.type === "reasoning_delta") this.#appendReasoning(event.messageId, event.offset, event.text);
		if (event.type === "assistant_message_completed") this.#completeAnswer(event.messageId);
		if (event.type === "tool_call") this.#tool(event.id, event.name, event.arguments);
		if (event.type === "tool_result") this.#toolResult(event.id, event.status, event.output, event.name);
		if (event.type === "usage") this.#usage(event);
		if (event.type === "queue_changed") {
			this.#view = {
				...this.#view,
				queue: event.queue,
				header: this.#view.header ? { ...this.#view.header, status: sessionStatus(event.queue) } : undefined,
			};
			const running = event.queue.running;
			if (running?.kind === "prompt") this.#prompt(running.messageId, running.text);
			this.#waitingCancellationTurnIds.clear();
			this.#notifyView();
		}
		if (event.type === "compaction_submitted") {
			this.#notice(
				`notice:${eventId}`,
				`Compaction ${event.admission === "running" ? "started" : "queued"} (${event.source}).`,
				"info",
			);
		}
		if (event.type === "compacted" && !this.#compactionTurnIds.has(event.turnId)) {
			this.#compactionTurnIds.add(event.turnId);
			this.#notice(
				`notice:${eventId}`,
				`Compacted context (${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens)\n${event.summary}`,
				"info",
			);
		}
		if (event.type === "compaction_skipped") {
			this.#notice(`notice:${eventId}`, "Nothing to compact.", "info");
		}
		if (event.type === "pruned") {
			this.#notice(
				`notice:${eventId}`,
				`Pruned ${event.toolCallIds.length} tool outputs (${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens).`,
				"info",
			);
		}
		if (event.type === "retry") {
			this.#notice(
				`notice:${eventId}`,
				`Retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs.toLocaleString("en-US")} ms: ${event.message}`,
				"info",
			);
		}
		if (event.type === "auth" && this.#authMode !== event.mode) {
			this.#authMode = event.mode;
			this.#notice(`notice:${eventId}`, `Authenticated with ${event.mode}.`, "info");
		}
		if (
			event.type === "turn_cancel_requested" &&
			this.#view.queue.waiting.some((item) => item.turnId === event.turnId)
		) {
			this.#waitingCancellationTurnIds.add(event.turnId);
		}
		if (event.type === "turn_cancel_requested" && !this.#waitingCancellationTurnIds.has(event.turnId)) {
			this.#setStatus("cancelling");
			this.#notice(`notice:${eventId}`, "Cancellation requested.", "info");
		}
		if (event.type === "error") {
			this.#setStatus("error");
			this.#notice(`notice:${eventId}`, event.message, "error");
		}
		if (event.type === "aborted" || event.type === "interrupted" || event.type === "cancelled") {
			const waitingCancellation = event.type === "cancelled" && this.#waitingCancellationTurnIds.has(event.turnId);
			if (!waitingCancellation) {
				this.#setStatus(event.type);
				this.#notice(`notice:${eventId}`, `Turn ${event.type}.`, event.type === "interrupted" ? "error" : "info");
			}
		}
		if (event.type === "turn_terminal") {
			const waitingCancellation = event.reason === "cancelled" && this.#waitingCancellationTurnIds.has(event.turnId);
			if (!waitingCancellation) {
				this.#setStatus(event.reason);
				if (event.reason !== "completed") {
					this.#notice(
						`notice:${eventId}`,
						`Turn ended: ${event.reason}.`,
						event.reason === "error" || event.reason === "interrupted" ? "error" : "info",
					);
				}
			}
		}
		this.#notifyActivity();
	}

	#prompt(id: Protocol.MessageId, text: string): void {
		if (this.#promptMessageIds.has(id)) return;
		this.#promptMessageIds.add(id);
		this.#addBlock({ kind: "prompt", key: `prompt:${id}`, text });
	}

	#answer(id: Protocol.MessageId, text: string, done: boolean): void {
		const key = `answer:${id}`;
		const current = this.#blocks.get(key)?.block;
		if (current?.kind === "answer") {
			if (text.length <= current.text.length && (!done || current.done)) return;
			this.#setBlock({ kind: "answer", key, text: text.length > current.text.length ? text : current.text, done });
		} else {
			this.#addBlock({ kind: "answer", key, text, done });
		}
		this.#messageOffsets.set(id, Math.max(this.#messageOffsets.get(id) ?? 0, text.length));
	}

	#appendAnswer(id: Protocol.MessageId, offset: number, text: string): void {
		const key = `answer:${id}`;
		const seen = this.#messageOffsets.get(id) ?? 0;
		const end = offset + text.length;
		if (end <= seen) return;
		if (offset > seen) throw new Error(`Missing assistant output before offset ${offset}`);
		const current = this.#blocks.get(key)?.block;
		const existing = current?.kind === "answer" ? current.text : "";
		const next = `${existing}${text.slice(seen - offset)}`;
		if (current?.kind === "answer") this.#setBlock({ ...current, text: next });
		if (current?.kind !== "answer") this.#addBlock({ kind: "answer", key, text: next, done: false });
		this.#messageOffsets.set(id, end);
	}

	#completeAnswer(id: Protocol.MessageId): void {
		const key = `answer:${id}`;
		const current = this.#blocks.get(key)?.block;
		if (current?.kind === "answer" && !current.done) this.#setBlock({ ...current, done: true });
	}

	#reasoning(id: Protocol.MessageId, text: string): void {
		const key = `reasoning:${id}`;
		this.#addBlock({ kind: "reasoning", key, text });
		this.#reasoningOffsets.set(id, text.length);
	}

	#appendReasoning(id: Protocol.MessageId, offset: number, text: string): void {
		const key = `reasoning:${id}`;
		const seen = this.#reasoningOffsets.get(id) ?? 0;
		const end = offset + text.length;
		if (end <= seen) return;
		if (offset > seen) throw new Error(`Missing reasoning output before offset ${offset}`);
		const current = this.#blocks.get(key)?.block;
		const existing = current?.kind === "reasoning" ? current.text : "";
		const next = `${existing}${text.slice(seen - offset)}`;
		if (current?.kind === "reasoning") this.#setBlock({ ...current, text: next });
		if (current?.kind !== "reasoning") this.#addBlock({ kind: "reasoning", key, text: next });
		this.#reasoningOffsets.set(id, end);
	}

	#tool(id: string, name: string, args: string): void {
		if (this.#toolCallIds.has(id)) return;
		this.#toolCallIds.add(id);
		const key = `tool:${id}`;
		this.#toolKeysByCallId.set(id, key);
		this.#addBlock({ kind: "tool", key, name, args });
	}

	#toolResult(id: string, status: "ok" | "error", output: string, name = "tool"): void {
		const key = this.#toolKeysByCallId.get(id) ?? `tool:${id}`;
		const current = this.#blocks.get(key)?.block;
		if (current?.kind === "tool") {
			if (current.result?.status === status && current.result.output === output) return;
			this.#setBlock({ ...current, result: { status, output } });
			return;
		}
		this.#toolCallIds.add(id);
		this.#toolKeysByCallId.set(id, key);
		this.#addBlock({ kind: "tool", key, name, args: "", result: { status, output } });
	}

	#notice(key: string, text: string, tone: "info" | "error"): void {
		if (this.#blocks.has(key)) return;
		this.#addBlock({ kind: "notice", key, text, tone });
	}

	#usage(event: Protocol.UsageEvent): void {
		const header = this.#view.header;
		if (!header) return;
		const previous = header.usage.cumulative;
		const cumulative: Protocol.Usage = {
			input: previous.input + event.usage.input,
			output: previous.output + event.usage.output,
			cacheRead: previous.cacheRead + event.usage.cacheRead,
			cacheWrite: previous.cacheWrite + event.usage.cacheWrite,
			total: previous.total + event.usage.total,
			...(previous.reasoning === undefined && event.usage.reasoning === undefined
				? {}
				: { reasoning: (previous.reasoning ?? 0) + (event.usage.reasoning ?? 0) }),
		};
		this.#view = {
			...this.#view,
			header: {
				...header,
				model: {
					provider: event.provider,
					id: event.model,
					...(header.model?.id === event.model && header.model.contextWindow !== undefined
						? { contextWindow: header.model.contextWindow }
						: {}),
					...(header.model?.id === event.model && header.model.maxOutputTokens !== undefined
						? { maxOutputTokens: header.model.maxOutputTokens }
						: {}),
				},
				usage: { ...header.usage, cumulative },
			},
		};
		this.#notifyView();
	}

	#setStatus(status: TranscriptHeader["status"]): void {
		if (!this.#view.header || this.#view.header.status === status) return;
		this.#view = { ...this.#view, header: { ...this.#view.header, status } };
		this.#notifyView();
	}

	#addBlock(block: Block): void {
		if (this.#blocks.has(block.key)) return;
		this.#blocks.set(block.key, { block, version: 1 });
		this.#view = { ...this.#view, blockKeys: [...this.#view.blockKeys, block.key] };
		this.#notifyBlock(block.key);
		this.#notifyView();
	}

	#setBlock(block: Block): void {
		const current = this.#blocks.get(block.key);
		this.#blocks.set(block.key, { block, version: (current?.version ?? 0) + 1 });
		this.#notifyBlock(block.key);
	}

	#notifyBlock(key: string): void {
		for (const listener of this.#blockListeners.get(key) ?? []) listener();
	}

	#notifyView(): void {
		for (const listener of this.#listeners) listener();
		this.#notifyActivity();
	}

	#notifyActivity(): void {
		for (const listener of this.#activityListeners) listener();
	}
}

function sessionStatus(queue: Protocol.QueueSnapshot): TranscriptHeader["status"] {
	if (queue.running) return queue.running.state;
	if (queue.waiting.length > 0) return "waiting";
	return "idle";
}

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}
