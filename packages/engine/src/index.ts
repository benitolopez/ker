import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import * as Llm from "@ker-ai/llm";
import type * as Protocol from "@ker-ai/protocol";

// A tool the loop can run: the wire schema the model sees, plus the execute the model never sees.
export interface Tool extends Llm.Tool {
	execute(args: unknown, signal?: AbortSignal): Promise<string>;
}

export interface EngineConfig {
	model: string;
	getAuth: (signal?: AbortSignal) => Promise<Llm.Auth>;
	tools: Tool[];
	systemPrompt: string;
	compaction: CompactionTemplate;
	reasoningEffort?: Llm.ReasoningEffort;
}

export interface Dependencies {
	stream: typeof Llm.stream;
}

export interface UserMessage {
	sessionId: Protocol.SessionId;
	turnId: Protocol.TurnId;
	messageId: Protocol.MessageId;
	text: string;
}

export interface CompactionTemplate {
	systemPrompt: string;
	initialInstructions: string;
	updateInstructions: string;
}

export interface CompactionRequest {
	sessionId: Protocol.SessionId;
	turnId: Protocol.TurnId;
	keepRecentTokens: number;
	contextWindow?: number;
	reasoningEffort?: Llm.ReasoningEffort;
	instructions?: string;
	previousSummary?: string;
}

export type CompactionOutcome =
	| {
			kind: "compacted";
			summary: string;
			keptCount: number;
			tokensBefore: number;
			tokensAfter: number;
			messages: Llm.Message[];
	  }
	| { kind: "skipped"; reason: "nothing_to_compact" }
	// retryable marks a transient provider failure that spent its retries here, so a later attempt
	// can still succeed without the conversation changing.
	| { kind: "stopped"; retryable?: true }
	| { kind: "aborted" };

export interface HarnessState {
	messages: Llm.Message[];
	identity?: Protocol.Identity;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const ABORTED_HISTORY_MARKER =
	"The previous turn was interrupted by the user. Aborted tools may have partially executed.";
const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const TOOL_CONTENT_MAX_CHARS = 2_000;
const MESSAGE_MAX_CHARS = 8_000;
const SUMMARY_MAX_TOKENS = 8_192;
const OUTPUT_HEADROOM_TOKENS = 32_000;
const INPUT_BUDGET_FALLBACK_CHARS = 400_000;
const MAX_CONTEXT_OVERFLOW_RETRIES = 3;
const PRUNE_PROTECT_TOKENS = 40_000;
const PRUNE_MINIMUM_TOKENS = 20_000;
const PRUNED_OUTPUT_PLACEHOLDER =
	"[Old tool output removed to free context space. Re-read the file or re-run the command if you still need it.]";

// Holds one credential-bound conversation in memory and runs the agent loop. Initial auth is checked
// before the user message enters history. Completed tool calls always trigger the next model request.
// Cancellation repairs advertised tool calls and records the interruption for the next turn.
export function createHarness(
	config: EngineConfig,
	dependencies: Dependencies = { stream: Llm.stream },
	initial: HarnessState = { messages: [] },
) {
	const messages: Llm.Message[] = structuredClone(initial.messages);
	let identity: Protocol.Identity | undefined = initial.identity;

	async function* send(input: UserMessage, signal?: AbortSignal): AsyncGenerator<Protocol.TurnEvent> {
		const scope = { sessionId: input.sessionId, turnId: input.turnId };
		const initialAuth = await resolveAuth(config, scope, identity, signal);
		if (initialAuth.kind === "aborted") {
			yield { actor: "process", ...scope, type: "aborted" };
			yield { actor: "process", ...scope, type: "end" };
			return;
		}
		if (initialAuth.kind === "error") {
			yield initialAuth.event;
			yield { actor: "process", ...scope, type: "end" };
			return;
		}

		identity ??= identityOf(initialAuth.auth);
		messages.push({ role: "user", content: input.text });
		yield {
			actor: "human",
			modelRole: "user",
			...scope,
			type: "message_delivered",
			messageId: input.messageId,
			text: input.text,
		};

		let firstStep = true;
		while (true) {
			const outcome = yield* streamStep(
				config,
				dependencies,
				messages,
				scope,
				identity,
				firstStep ? initialAuth.auth : undefined,
				signal,
			);
			firstStep = false;
			if (outcome.kind === "aborted" || signal?.aborted) {
				if (outcome.kind !== "stopped") {
					for (const event of skipToolCalls(messages, scope, outcome.toolCalls)) yield event;
				}
				messages.push({ role: "developer", content: ABORTED_HISTORY_MARKER });
				yield { actor: "process", ...scope, type: "aborted" };
				yield { actor: "process", ...scope, type: "end" };
				return;
			}
			if (outcome.kind === "stopped") {
				yield { actor: "process", ...scope, type: "end" };
				return;
			}

			let interrupted = false;
			for (let index = 0; index < outcome.toolCalls.length; index++) {
				const call = outcome.toolCalls[index];
				if (signal?.aborted) {
					for (const event of skipToolCalls(messages, scope, outcome.toolCalls.slice(index))) yield event;
					interrupted = true;
					break;
				}
				const result = await runTool(config.tools, call, signal);
				messages.push({ role: "tool", toolCallId: call.callId, content: result.output });
				yield {
					actor: "process",
					modelRole: "tool",
					...scope,
					type: "tool_result",
					id: call.callId,
					name: call.name,
					status: result.status,
					output: result.output,
				};
				if (signal?.aborted) {
					for (const event of skipToolCalls(messages, scope, outcome.toolCalls.slice(index + 1))) yield event;
					interrupted = true;
					break;
				}
			}
			if (interrupted) {
				messages.push({ role: "developer", content: ABORTED_HISTORY_MARKER });
				yield { actor: "process", ...scope, type: "aborted" };
				yield { actor: "process", ...scope, type: "end" };
				return;
			}

			if (outcome.toolCalls.length === 0) break;
		}

		yield { actor: "process", ...scope, type: "end" };
	}

	function snapshot(): HarnessState {
		return { messages: structuredClone(messages), identity };
	}

	async function* compact(
		request: CompactionRequest,
		signal?: AbortSignal,
	): AsyncGenerator<Protocol.TurnEvent, CompactionOutcome> {
		return yield* compactMessages(config, dependencies, messages, identity, request, signal);
	}

	return { messages, send, compact, snapshot };
}

type StepOutcome =
	| { kind: "aborted"; toolCalls: Llm.ToolCall[] }
	| { kind: "stopped" }
	| { kind: "done"; toolCalls: Llm.ToolCall[] };

// Stream one model step, recording completed output or readable reasoning collected before an abort.
// Encrypted reasoning is retained on abort only with a following tool call because the provider rejects
// it alone. Retries use fresh auth before visible output; once output is visible, an error stops the turn.
async function* streamStep(
	config: EngineConfig,
	dependencies: Dependencies,
	messages: Llm.Message[],
	scope: Pick<UserMessage, "sessionId" | "turnId">,
	identity: Protocol.Identity,
	initialAuth?: Llm.Auth,
	signal?: AbortSignal,
): AsyncGenerator<Protocol.TurnEvent, StepOutcome> {
	const messageId = randomUUID();
	let textOffset = 0;
	let reasoningOffset = 0;
	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) return { kind: "aborted", toolCalls: [] };
		const authResult: AuthResult =
			attempt === 0 && initialAuth
				? { kind: "ready", auth: initialAuth }
				: await resolveAuth(config, scope, identity, signal);
		if (authResult.kind === "aborted") return { kind: "aborted", toolCalls: [] };
		if (authResult.kind === "error") {
			yield authResult.event;
			return { kind: "stopped" };
		}
		const auth = authResult.auth;
		if (initialAuth && attempt === 0) {
			yield { actor: "process", ...scope, type: "auth", mode: auth.kind };
		}
		let reply = "";
		let reasoningSummary = "";
		const toolCalls: Llm.ToolCall[] = [];
		const reasoning: unknown[] = [];
		let sawOutput = false;
		let pending: { delayMs: number; message: string } | undefined;

		for await (const event of dependencies.stream(config.model, messages, auth, {
			tools: config.tools,
			instructions: config.systemPrompt,
			reasoningEffort: config.reasoningEffort,
			signal,
		})) {
			if (signal?.aborted || event.type === "aborted") {
				if (toolCalls.length > 0 || reasoningSummary) {
					messages.push({
						role: "assistant",
						content: "",
						toolCalls,
						reasoning: toolCalls.length > 0 ? reasoning : [],
						...(reasoningSummary ? { reasoningSummary } : {}),
					});
				}
				return { kind: "aborted", toolCalls };
			}
			if (event.type !== "done" && event.type !== "error") sawOutput = true;
			if (event.type === "delta") {
				reply += event.text;
				yield {
					actor: "agent",
					modelRole: "assistant",
					...scope,
					type: "message_delta",
					messageId,
					offset: textOffset,
					text: event.text,
				};
				textOffset += event.text.length;
			}
			if (event.type === "tool_call") {
				toolCalls.push({
					callId: event.callId,
					itemId: event.itemId,
					name: event.name,
					arguments: event.arguments,
				});
				yield {
					actor: "agent",
					modelRole: "assistant",
					...scope,
					type: "tool_call",
					messageId,
					id: event.callId,
					name: event.name,
					arguments: event.arguments,
				};
			}
			if (event.type === "reasoning_delta") {
				reasoningSummary += event.text;
				yield {
					actor: "agent",
					modelRole: "assistant",
					...scope,
					type: "reasoning_delta",
					messageId,
					offset: reasoningOffset,
					text: event.text,
				};
				reasoningOffset += event.text.length;
			}
			if (event.type === "reasoning") reasoning.push(event.item);
			if (event.type === "done") {
				const provider = Llm.providerOf(auth);
				if (event.reason === "content_filter") {
					yield {
						actor: "process",
						...scope,
						type: "usage",
						provider,
						model: config.model,
						usage: event.usage,
					};
					yield {
						actor: "process",
						...scope,
						type: "error",
						message: "The model response was stopped by a content filter",
					};
					return { kind: "stopped" };
				}
				messages.push({
					role: "assistant",
					content: reply,
					toolCalls,
					reasoning,
					...(reasoningSummary ? { reasoningSummary } : {}),
					provider,
					model: config.model,
					usage: event.usage,
				});
				yield {
					actor: "agent",
					modelRole: "assistant",
					...scope,
					type: "assistant_message_completed",
					messageId,
					reason: event.reason === "length" ? "length" : "completed",
				};
				yield {
					actor: "process",
					...scope,
					type: "usage",
					provider,
					model: config.model,
					usage: event.usage,
				};
				return { kind: "done", toolCalls };
			}
			if (event.type === "error") {
				if (!sawOutput && event.retryable && attempt < MAX_RETRIES) {
					const delayMs = Math.min(event.retryAfterMs ?? BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
					pending = { delayMs, message: event.message };
					break;
				}
				yield { actor: "process", ...scope, type: "error", message: event.message };
				return { kind: "stopped" };
			}
		}

		if (!pending) return { kind: "stopped" };
		yield {
			actor: "process",
			...scope,
			type: "retry",
			attempt: attempt + 1,
			maxAttempts: MAX_RETRIES,
			delayMs: pending.delayMs,
			message: pending.message,
		};
		try {
			await sleep(pending.delayMs, undefined, { signal });
		} catch (error) {
			if (signal?.aborted) return { kind: "aborted", toolCalls: [] };
			throw error;
		}
	}
}

export function estimateContextTokens(messages: readonly Llm.Message[]): number {
	const lastUsageIndex = messages.findLastIndex(
		(message) =>
			message.role === "assistant" &&
			message.provider !== undefined &&
			message.model !== undefined &&
			message.usage !== undefined &&
			usageTokens(message.usage) > 0,
	);
	const lastUsage = lastUsageIndex === -1 ? undefined : messages[lastUsageIndex];
	const reported = lastUsage?.role === "assistant" && lastUsage.usage ? usageTokens(lastUsage.usage) : 0;
	const trailingCharacters = messages
		.slice(lastUsageIndex + 1)
		.reduce((total, message) => total + messageCharacters(message), 0);
	return reported + Math.ceil(trailingCharacters / 4);
}

function usageTokens(usage: Llm.Usage): number {
	return usage.total || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function messageCharacters(message: Llm.Message): number {
	if (message.role === "user" || message.role === "developer") return message.content.length;
	if (message.role === "tool") return message.toolCallId.length + message.content.length;
	const calls = (message.toolCalls ?? []).reduce(
		(total, call) => total + call.callId.length + (call.itemId?.length ?? 0) + call.name.length + call.arguments.length,
		0,
	);
	const reasoning = (message.reasoning ?? []).reduce<number>((total, item) => {
		try {
			return total + (JSON.stringify(item)?.length ?? 0);
		} catch {
			return total;
		}
	}, 0);
	return message.content.length + calls + reasoning;
}

export function compactionSummaryMessage(summary: string): Llm.Message {
	return { role: "developer", content: `${COMPACTION_SUMMARY_PREFIX}${summary}\n</summary>` };
}

export function stripAssistantUsage(message: Llm.Message): Llm.Message {
	if (message.role !== "assistant") return structuredClone(message);
	const { provider: _provider, model: _model, usage: _usage, ...rest } = message;
	return structuredClone(rest);
}

export interface PruneOutcome {
	toolCallIds: string[];
	messages: Llm.Message[];
	tokensBefore: number;
	tokensAfter: number;
}

export function pruneToolOutputs(messages: readonly Llm.Message[]): PruneOutcome | undefined {
	let userTurns = 0;
	let protectedTokens = 0;
	const toolCallIds: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "user") {
			userTurns++;
			continue;
		}
		if (userTurns < 2 || message.role !== "tool" || message.content === PRUNED_OUTPUT_PLACEHOLDER) {
			continue;
		}
		protectedTokens += Math.ceil(message.content.length / 4);
		if (protectedTokens > PRUNE_PROTECT_TOKENS) toolCallIds.push(message.toolCallId);
	}
	if (toolCallIds.length === 0) return undefined;

	const selected = new Set(toolCallIds);
	const occurrences = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "tool" || !selected.has(message.toolCallId)) continue;
		occurrences.set(message.toolCallId, (occurrences.get(message.toolCallId) ?? 0) + 1);
	}
	if ([...occurrences.values()].some((count) => count > 1)) return undefined;

	const normalizedBefore = messages.map(stripAssistantUsage);
	const after = applyPrune(normalizedBefore, toolCallIds);
	const tokensBefore = estimateContextTokens(normalizedBefore);
	const tokensAfter = estimateContextTokens(after);
	if (tokensBefore - tokensAfter < PRUNE_MINIMUM_TOKENS) return undefined;
	return { toolCallIds, messages: after, tokensBefore, tokensAfter };
}

export function applyPrune(messages: readonly Llm.Message[], toolCallIds: readonly string[]): Llm.Message[] {
	const selected = new Set(toolCallIds);
	return messages.map((message) => {
		const normalized = stripAssistantUsage(message);
		if (normalized.role !== "tool" || !selected.has(normalized.toolCallId)) return normalized;
		return { ...normalized, content: PRUNED_OUTPUT_PLACEHOLDER };
	});
}

// Summarize the removable prefix without changing live history. The caller persists the result before
// replacing its harness, so a failed append leaves the conversation untouched. Every attempt rebuilds
// the summary from scratch, so unlike a visible model response this one retries even after partial
// text arrived.
async function* compactMessages(
	config: EngineConfig,
	dependencies: Dependencies,
	messages: Llm.Message[],
	identity: Protocol.Identity | undefined,
	request: CompactionRequest,
	signal?: AbortSignal,
): AsyncGenerator<Protocol.TurnEvent, CompactionOutcome> {
	const cut = findCompactionCut(messages, request.keepRecentTokens);
	if (cut === undefined || cut === 0) return { kind: "skipped", reason: "nothing_to_compact" };
	const scope = { sessionId: request.sessionId, turnId: request.turnId };
	const initialBudgetChars =
		request.contextWindow === undefined
			? INPUT_BUDGET_FALLBACK_CHARS
			: 4 *
				Math.max(0, request.contextWindow - Math.min(OUTPUT_HEADROOM_TOKENS, Math.floor(request.contextWindow / 2)));
	const initialPrompt = renderCompactionPrompt(messages.slice(0, cut), config.compaction, request, initialBudgetChars);
	if (initialPrompt.kind === "empty") return { kind: "skipped", reason: "nothing_to_compact" };
	if (initialPrompt.kind === "too_large") {
		yield {
			actor: "process",
			...scope,
			type: "error",
			message: "The summary request cannot fit the model context",
		};
		return { kind: "stopped" };
	}

	const initialAuth = await resolveAuth(config, scope, identity, signal);
	if (initialAuth.kind === "aborted") return { kind: "aborted" };
	if (initialAuth.kind === "error") {
		yield initialAuth.event;
		return { kind: "stopped" };
	}

	let prompt = initialPrompt.prompt;
	let budgetChars = initialBudgetChars;
	let transientAttempts = 0;
	let overflowRetries = 0;
	let firstAttempt = true;

	while (true) {
		if (signal?.aborted) return { kind: "aborted" };
		const authResult: AuthResult = firstAttempt ? initialAuth : await resolveAuth(config, scope, identity, signal);
		firstAttempt = false;
		if (authResult.kind === "aborted") return { kind: "aborted" };
		if (authResult.kind === "error") {
			yield authResult.event;
			return { kind: "stopped" };
		}
		const auth = authResult.auth;
		let summary = "";
		let pending: { delayMs: number; message: string } | undefined;
		let overflowPending: { message: string } | undefined;

		for await (const event of dependencies.stream(config.model, [prompt], auth, {
			instructions: config.compaction.systemPrompt,
			reasoningEffort: request.reasoningEffort ?? config.reasoningEffort,
			signal,
		})) {
			if (signal?.aborted || event.type === "aborted") return { kind: "aborted" };
			if (event.type === "delta") summary += event.text;
			if (event.type === "done") {
				const provider = Llm.providerOf(auth);
				yield {
					actor: "process",
					...scope,
					type: "usage",
					provider,
					model: config.model,
					usage: event.usage,
				};
				if (event.reason === "content_filter") {
					yield {
						actor: "process",
						...scope,
						type: "error",
						message: "The model response was stopped by a content filter",
					};
					return { kind: "stopped" };
				}
				if (event.reason === "length") {
					yield {
						actor: "process",
						...scope,
						type: "error",
						message: "The summary hit the model's output limit",
					};
					return { kind: "stopped" };
				}
				const content = summary.trim();
				if (!content) {
					yield {
						actor: "process",
						...scope,
						type: "error",
						message: "Summarization returned no content",
					};
					return { kind: "stopped" };
				}
				if (Math.ceil(content.length / 4) > SUMMARY_MAX_TOKENS) {
					yield {
						actor: "process",
						...scope,
						type: "error",
						message: `The summary exceeded the ${SUMMARY_MAX_TOKENS}-token size limit`,
					};
					return { kind: "stopped" };
				}
				if (signal?.aborted) return { kind: "aborted" };
				const normalizedMessages = messages.map(stripAssistantUsage);
				const nextMessages = [compactionSummaryMessage(content), ...normalizedMessages.slice(cut)];
				return {
					kind: "compacted",
					summary: content,
					keptCount: messages.length - cut,
					tokensBefore: estimateContextTokens(normalizedMessages),
					tokensAfter: estimateContextTokens(nextMessages),
					messages: nextMessages,
				};
			}
			if (event.type === "error") {
				if (event.contextOverflow && overflowRetries < MAX_CONTEXT_OVERFLOW_RETRIES) {
					const nextBudgetChars = Math.floor(budgetChars / 2);
					const nextPrompt = renderCompactionPrompt(
						messages.slice(0, cut),
						config.compaction,
						request,
						nextBudgetChars,
					);
					if (nextPrompt.kind === "too_large") {
						yield {
							actor: "process",
							...scope,
							type: "error",
							message: "The summary request cannot fit the model context",
						};
						return { kind: "stopped" };
					}
					if (nextPrompt.kind === "empty" || nextPrompt.prompt.content.length >= prompt.content.length) {
						yield { actor: "process", ...scope, type: "error", message: event.message };
						return { kind: "stopped" };
					}
					prompt = nextPrompt.prompt;
					budgetChars = nextBudgetChars;
					overflowRetries++;
					overflowPending = { message: event.message };
					break;
				}
				if (event.retryable && transientAttempts < MAX_RETRIES) {
					const delayMs = Math.min(event.retryAfterMs ?? BASE_DELAY_MS * 2 ** transientAttempts, MAX_DELAY_MS);
					pending = { delayMs, message: event.message };
					break;
				}
				yield { actor: "process", ...scope, type: "error", message: event.message };
				return event.retryable ? { kind: "stopped", retryable: true } : { kind: "stopped" };
			}
		}

		if (overflowPending) {
			yield {
				actor: "process",
				...scope,
				type: "retry",
				attempt: overflowRetries,
				maxAttempts: MAX_CONTEXT_OVERFLOW_RETRIES,
				delayMs: 0,
				message: overflowPending.message,
			};
			continue;
		}
		if (!pending) return { kind: "stopped" };
		yield {
			actor: "process",
			...scope,
			type: "retry",
			attempt: transientAttempts + 1,
			maxAttempts: MAX_RETRIES,
			delayMs: pending.delayMs,
			message: pending.message,
		};
		transientAttempts++;
		try {
			await sleep(pending.delayMs, undefined, { signal });
		} catch (error) {
			if (signal?.aborted) return { kind: "aborted" };
			throw error;
		}
	}
}

function findCompactionCut(messages: readonly Llm.Message[], keepRecentTokens: number): number | undefined {
	let accumulated = 0;
	let crossing: number | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		accumulated += Math.ceil(messageCharacters(messages[index]) / 4);
		if (accumulated < keepRecentTokens) continue;
		crossing = index;
		break;
	}
	if (crossing === undefined) return undefined;
	const crossingMessage = messages[crossing];
	if (isCompactionCutMessage(crossingMessage)) return crossing;
	if (crossingMessage.role === "tool") {
		const toolCallId = crossingMessage.toolCallId;
		const owner = messages.findLastIndex(
			(message, index) =>
				index < crossing &&
				message.role === "assistant" &&
				(message.toolCalls ?? []).some((call) => call.callId === toolCallId),
		);
		if (owner !== -1) return owner;
	}
	for (let index = crossing + 1; index < messages.length; index++) {
		if (isCompactionCutMessage(messages[index])) return index;
	}
	return undefined;
}

function isCompactionCutMessage(message: Llm.Message): boolean {
	if (message.role === "tool") return false;
	return message.role !== "developer" || !message.content.startsWith(COMPACTION_SUMMARY_PREFIX);
}

type CompactionPrompt =
	| { kind: "ready"; prompt: Extract<Llm.Message, { role: "user" }> }
	| { kind: "empty" }
	| { kind: "too_large" };

// Fits the complete rendered prompt inside the attempt budget. The previous summary, instructions,
// and focus stay outside the oldest-first droppable conversation region.
function renderCompactionPrompt(
	messages: readonly Llm.Message[],
	template: CompactionTemplate,
	request: CompactionRequest,
	totalBudgetChars: number,
): CompactionPrompt {
	const instructions = request.previousSummary ? template.updateInstructions : template.initialInstructions;
	const previous = request.previousSummary
		? `\n\n<previous-summary>\n${request.previousSummary}\n</previous-summary>`
		: "";
	const focus = request.instructions ? `\n\nAdditional focus: ${request.instructions}` : "";
	const prefix = "<conversation>\n";
	const suffix = `\n</conversation>${previous}\n\n${instructions}${focus}`;
	const conversationBudgetChars = Math.max(0, totalBudgetChars - prefix.length - suffix.length);
	const conversation = serializeConversation(messages, conversationBudgetChars);
	if (conversation?.kind === "empty") return { kind: "empty" };
	if (!conversation) return { kind: "too_large" };
	const content = `${prefix}${conversation.content}${suffix}`;
	if (content.length > totalBudgetChars) return { kind: "too_large" };
	return { kind: "ready", prompt: { role: "user", content } };
}

function serializeConversation(
	messages: readonly Llm.Message[],
	budgetChars: number,
): { kind: "ready"; content: string } | { kind: "empty" } | undefined {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			if (message.content) {
				parts.push(`[User]: ${truncateForSummary(message.content, MESSAGE_MAX_CHARS)}`);
			}
			continue;
		}
		if (message.role === "developer") {
			if (!message.content.startsWith(COMPACTION_SUMMARY_PREFIX) && message.content) {
				parts.push(`[Developer]: ${truncateForSummary(message.content, MESSAGE_MAX_CHARS)}`);
			}
			continue;
		}
		if (message.role === "tool") {
			if (message.content) {
				parts.push(`[Tool result]: ${truncateForSummary(message.content, TOOL_CONTENT_MAX_CHARS)}`);
			}
			continue;
		}
		const assistant: string[] = [];
		if (message.content) assistant.push(`[Assistant]: ${message.content}`);
		const calls = (message.toolCalls ?? []).map(
			(call) => `${call.name}(${truncateForSummary(call.arguments, TOOL_CONTENT_MAX_CHARS)})`,
		);
		if (calls.length > 0) assistant.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		if (assistant.length > 0) parts.push(assistant.join("\n\n"));
	}
	if (parts.length === 0) return { kind: "empty" };
	const complete = parts.join("\n\n");
	if (complete.length <= budgetChars) return { kind: "ready", content: complete };
	const suffixLengths = new Array<number>(parts.length + 1).fill(0);
	for (let index = parts.length - 1; index >= 0; index--) {
		suffixLengths[index] = parts[index].length + (index === parts.length - 1 ? 0 : 2 + suffixLengths[index + 1]);
	}
	for (let omitted = 1; omitted <= parts.length; omitted++) {
		const marker = `[... ${omitted} earlier messages omitted from this summary request]`;
		const remainingLength = omitted === parts.length ? 0 : 2 + suffixLengths[omitted];
		if (marker.length + remainingLength > budgetChars) continue;
		return { kind: "ready", content: [marker, ...parts.slice(omitted)].join("\n\n") };
	}
	return undefined;
}

// Keeps the opening and latest text while reserving room for the exact truncation marker.
function truncateForSummary(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let omitted = text.length;
	while (true) {
		const marker = `\n\n[... ${omitted} characters truncated]\n\n`;
		const available = Math.max(0, limit - marker.length);
		const nextOmitted = text.length - available;
		if (nextOmitted !== omitted) {
			omitted = nextOmitted;
			continue;
		}
		if (available === 0) return marker.slice(0, limit);
		const head = Math.ceil(available * 0.75);
		const tail = available - head;
		return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
	}
}

type AuthResult =
	| { kind: "ready"; auth: Llm.Auth }
	| { kind: "aborted" }
	| { kind: "error"; event: Protocol.ErrorEvent };

async function resolveAuth(
	config: EngineConfig,
	scope: Pick<UserMessage, "sessionId" | "turnId">,
	expected?: Protocol.Identity,
	signal?: AbortSignal,
): Promise<AuthResult> {
	if (signal?.aborted) return { kind: "aborted" };
	try {
		const auth = await config.getAuth(signal);
		if (signal?.aborted) return { kind: "aborted" };
		const actual = identityOf(auth);
		if (expected && !sameIdentity(expected, actual)) {
			return {
				kind: "error",
				event: {
					actor: "process",
					...scope,
					type: "error",
					code: "identity_changed",
					expected,
					actual,
					message: `Session belongs to ${describeIdentity(expected)}, but ${describeIdentity(actual)} is active.`,
				},
			};
		}
		return { kind: "ready", auth };
	} catch (err) {
		if (signal?.aborted) return { kind: "aborted" };
		return {
			kind: "error",
			event: {
				actor: "process",
				...scope,
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			},
		};
	}
}

// The explicit return type makes the switch exhaustive: a new Auth kind fails to compile here
// instead of silently collapsing into the API-key identity.
function identityOf(auth: Llm.Auth): Protocol.Identity {
	switch (auth.kind) {
		case "oauth":
			return { kind: "oauth", accountId: auth.accountId };
		case "apikey":
			return { kind: "apikey" };
	}
}

function sameIdentity(expected: Protocol.Identity, actual: Protocol.Identity): boolean {
	if (expected.kind !== actual.kind) return false;
	if (expected.kind === "oauth" && actual.kind === "oauth") return expected.accountId === actual.accountId;
	return true;
}

function describeIdentity(identity: Protocol.Identity): string {
	if (identity.kind === "oauth") return `OAuth account ${identity.accountId}`;
	return "an API key";
}

// Run one tool call, converting every failure into an error result the model receives as its output.
async function runTool(
	tools: Tool[],
	call: Llm.ToolCall,
	signal?: AbortSignal,
): Promise<{ status: "ok" | "error"; output: string }> {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) return { status: "error", output: `Tool ${call.name} not found` };
	try {
		const args: unknown = JSON.parse(call.arguments);
		signal?.throwIfAborted();
		return { status: "ok", output: await tool.execute(args, signal) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const output =
			signal?.aborted && !/aborted by user/i.test(message)
				? `${message}\n\n[aborted by user; tool may have partially executed]`
				: message;
		return { status: "error", output };
	}
}

function skipToolCalls(
	messages: Llm.Message[],
	scope: Pick<UserMessage, "sessionId" | "turnId">,
	calls: Llm.ToolCall[],
): Protocol.ToolResultEvent[] {
	return calls.map((call) => {
		const output = "Tool not executed because the turn was aborted.";
		messages.push({ role: "tool", toolCallId: call.callId, content: output });
		return {
			actor: "process",
			modelRole: "tool",
			...scope,
			type: "tool_result",
			id: call.callId,
			name: call.name,
			status: "error",
			output,
		};
	});
}
