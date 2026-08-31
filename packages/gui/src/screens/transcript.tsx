import { AttachError, type Result } from "@ker-ai/client";
import type * as Protocol from "@ker-ai/protocol";
import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import { api, attach } from "../api.ts";
import { formatTokens } from "../format.ts";
import { formatRoute } from "../router.ts";
import { type Block, TranscriptStore } from "../store/transcript.ts";

export function TranscriptScreen({ projectId, sessionId }: { projectId: string; sessionId: string }) {
	const [store] = useState(() => new TranscriptStore());
	const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const [error, setError] = useState<string>();
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const animation = useRef<number | undefined>(undefined);

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				for await (const item of attach(api, sessionId, { signal: controller.signal })) {
					if (item.kind === "snapshot") store.reset(item.snapshot);
					if (item.kind === "event") store.apply(item.envelope);
				}
			} catch (failure) {
				if (controller.signal.aborted) return;
				setError(
					failure instanceof AttachError
						? (failure.error.message ?? failure.error.code)
						: failure instanceof Error
							? failure.message
							: String(failure),
				);
			}
		})();
		return () => controller.abort();
	}, [sessionId, store]);

	useEffect(
		() =>
			store.subscribeActivity(() => {
				if (!pinned.current) return;
				if (animation.current !== undefined) cancelAnimationFrame(animation.current);
				animation.current = requestAnimationFrame(() => {
					const container = scrollRef.current;
					if (container) container.scrollTop = container.scrollHeight;
				});
			}),
		[store],
	);

	const header = view.header;
	return (
		<div className="flex h-screen min-h-0 flex-col bg-[var(--background)]">
			<header className="z-10 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--background)_88%,transparent)] px-5 py-4 backdrop-blur-xl sm:px-8">
				<div className="mx-auto flex max-w-5xl items-center justify-between gap-5">
					<div className="min-w-0">
						<a className="back-link" href={formatRoute({ screen: "sessions", projectId })}>
							← Sessions
						</a>
						<h1 className="mt-1 truncate font-mono text-sm font-semibold text-[var(--text)]">{sessionId}</h1>
					</div>
					{header ? (
						<SessionHeader header={header} queue={view.queue} onCompact={() => api.compact(sessionId)} />
					) : (
						<span className="status-pill">Connecting…</span>
					)}
				</div>
			</header>

			<div
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-8"
				onScroll={(event) => {
					const element = event.currentTarget;
					pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
				}}
				ref={scrollRef}
			>
				<main className="mx-auto w-full max-w-3xl py-10">
					{error ? (
						<div className="notice-block border-red-500/25 bg-red-500/8 text-red-700 dark:text-red-300">{error}</div>
					) : null}
					{!header && !error ? <div className="text-sm text-[var(--muted)]">Loading transcript…</div> : null}
					<div className="space-y-5">
						{view.blockKeys.map((key) => (
							<BlockView key={key} store={store} blockKey={key} />
						))}
					</div>
					<div className="h-12" />
				</main>
			</div>
			<footer className="border-t border-[var(--line)] bg-[var(--surface)] px-5 py-4 shadow-[0_-12px_35px_rgb(20_35_27_/_5%)] sm:px-8">
				<div className="mx-auto w-full max-w-3xl">
					<QueueStack queue={view.queue} onRemove={(turnId) => api.cancel(sessionId, turnId)} />
					<Composer
						queue={view.queue}
						onSend={(text) => api.prompt(sessionId, text)}
						onStop={(turnId) => api.cancel(sessionId, turnId)}
					/>
				</div>
			</footer>
		</div>
	);
}

export function SessionHeader({
	header,
	queue,
	onCompact,
}: {
	header: NonNullable<ReturnType<TranscriptStore["getSnapshot"]>["header"]>;
	queue: Protocol.QueueSnapshot;
	onCompact: () => Promise<Result<Protocol.CompactionAdmission>>;
}) {
	const [compacting, setCompacting] = useState(false);
	const [error, setError] = useState<string>();
	const window = header.model?.contextWindow;
	const percentage = window ? Math.min(100, (header.usage.contextTokens / window) * 100) : undefined;
	const compactionQueued = [queue.running, ...queue.waiting].some((item) => item?.kind === "compaction");
	const compact = async () => {
		setCompacting(true);
		setError(undefined);
		try {
			const result = await onCompact();
			if (!result.ok) setError(result.error.message ?? result.error.code);
		} catch (failure) {
			setError(failureMessage(failure));
		} finally {
			setCompacting(false);
		}
	};
	return (
		<div className="flex items-center gap-3 text-right sm:gap-5">
			<div className="hidden sm:block">
				<p className="text-xs font-medium text-[var(--text)]">
					{header.model ? `${header.model.provider}/${header.model.id}` : "Model unknown"}
				</p>
				<p className="mt-1 text-xs text-[var(--muted)]">
					{formatTokens(header.usage.contextTokens)}
					{window ? ` / ${formatTokens(window)}` : ""} context · {formatTokens(header.usage.cumulative.total)} total
				</p>
				{percentage !== undefined ? (
					<div className="mt-2 h-1 w-48 overflow-hidden rounded-full bg-[var(--line)]">
						<div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${percentage}%` }} />
					</div>
				) : null}
			</div>
			<div>
				<button
					className="rounded-full border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
					disabled={compactionQueued || compacting}
					onClick={() => void compact()}
					type="button"
				>
					{compacting ? "Compacting…" : "Compact"}
				</button>
				{error ? (
					<p className="mt-1 max-w-48 text-xs text-red-700 dark:text-red-300" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<span className="status-pill capitalize">{header.status}</span>
		</div>
	);
}

function BlockView({ store, blockKey }: { store: TranscriptStore; blockKey: string }) {
	const snapshot = useSyncExternalStore(
		(listener) => store.subscribeBlock(blockKey, listener),
		() => store.getBlockSnapshot(blockKey),
	);
	const block = snapshot.block;
	if (!block) return null;
	if (block.kind === "prompt") {
		return (
			<section className="ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-[var(--prompt)] px-5 py-4 text-[var(--prompt-text)] shadow-sm">
				<p className="whitespace-pre-wrap text-sm leading-6">{block.text}</p>
			</section>
		);
	}
	if (block.kind === "answer") {
		return (
			<section className="answer-block">
				<Markdown text={block.text} />
				{!block.done ? <span className="stream-caret" /> : null}
			</section>
		);
	}
	if (block.kind === "reasoning") {
		return (
			<details className="fold-block">
				<summary>Reasoning</summary>
				<div className="mt-3 border-t border-[var(--line)] pt-3 text-sm text-[var(--muted)]">
					<Markdown text={block.text} />
				</div>
			</details>
		);
	}
	if (block.kind === "tool") return <ToolBlock block={block} />;
	return (
		<div className={`notice-block ${block.tone === "error" ? "notice-error" : ""}`}>
			<span className="font-mono text-[10px] font-semibold tracking-[0.16em] uppercase">
				{block.tone === "error" ? "Error" : "Process"}
			</span>
			<p className="mt-2 whitespace-pre-wrap text-sm leading-6">{block.text}</p>
		</div>
	);
}

function ToolBlock({ block }: { block: Extract<Block, { kind: "tool" }> }) {
	return (
		<details className="fold-block">
			<summary className="flex items-center gap-3">
				<span className={`size-2 rounded-full ${block.result?.status === "error" ? "bg-red-500" : "bg-sky-500"}`} />
				<span className="font-mono text-xs font-semibold">{block.name}</span>
				<span className="ml-auto text-xs text-[var(--faint)]">
					{block.result ? (block.result.status === "ok" ? "done" : "failed") : "running"}
				</span>
			</summary>
			<div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3">
				{block.args ? <Code text={block.args} /> : null}
				{block.result ? <Code text={block.result.output} error={block.result.status === "error"} /> : null}
			</div>
		</details>
	);
}

function Code({ text, error = false }: { text: string; error?: boolean }) {
	return (
		<pre
			className={`max-h-96 overflow-auto rounded-xl border p-4 font-mono text-xs leading-5 ${error ? "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300" : "border-[var(--line)] bg-[var(--code)] text-[var(--muted)]"}`}
		>
			{text}
		</pre>
	);
}

function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown">
			<ReactMarkdown>{text}</ReactMarkdown>
		</div>
	);
}

export function QueueStack({
	queue,
	onRemove,
}: {
	queue: Protocol.QueueSnapshot;
	onRemove: (turnId: Protocol.TurnId) => Promise<Result<Protocol.TurnCancellationResult>>;
}) {
	const [removing, setRemoving] = useState<Protocol.TurnId>();
	const [error, setError] = useState<string>();
	if (queue.waiting.length === 0) return null;
	const remove = async (turnId: Protocol.TurnId) => {
		setRemoving(turnId);
		setError(undefined);
		try {
			const result = await onRemove(turnId);
			if (!result.ok && !(result.status === 409 && result.error.code === "turn_unavailable")) {
				setError(result.error.message ?? result.error.code);
			}
		} catch (failure) {
			setError(failureMessage(failure));
		} finally {
			setRemoving(undefined);
		}
	};
	return (
		<aside className="mb-3 space-y-2" aria-label="Waiting queue">
			{queue.waiting.map((item) => (
				<div
					className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-muted)] px-4 py-3 text-sm"
					key={item.id}
				>
					<span className="min-w-0 flex-1 truncate text-left text-[var(--muted)]">
						{item.kind === "prompt" ? item.text : `${item.source === "auto" ? "Automatic" : "Manual"} compaction`}
					</span>
					{item.kind === "prompt" ? (
						<button
							aria-label={`Remove queued prompt: ${item.text}`}
							className="grid size-7 shrink-0 place-items-center rounded-full text-lg text-[var(--faint)] hover:bg-red-500/10 hover:text-red-600 disabled:opacity-45"
							disabled={removing === item.turnId}
							onClick={() => void remove(item.turnId)}
							type="button"
						>
							<span aria-hidden="true">×</span>
						</button>
					) : null}
				</div>
			))}
			{error ? (
				<p className="text-xs text-red-700 dark:text-red-300" role="alert">
					{error}
				</p>
			) : null}
		</aside>
	);
}

export function Composer({
	queue,
	onSend,
	onStop,
}: {
	queue: Protocol.QueueSnapshot;
	onSend: (text: string) => Promise<Result<Protocol.PromptAdmission>>;
	onStop: (turnId: Protocol.TurnId) => Promise<Result<Protocol.TurnCancellationResult>>;
}) {
	const [text, setText] = useState("");
	const [pending, setPending] = useState<"send" | "stop">();
	const [error, setError] = useState<string>();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => textareaRef.current?.focus(), []);
	const hasText = text.trim().length > 0;
	const stopMode = queue.running !== undefined && !hasText;
	const cancelling = stopMode && queue.running?.state === "cancelling";
	const disabled = pending !== undefined || (stopMode ? cancelling : !hasText);
	const label = stopMode
		? cancelling || pending === "stop"
			? "Cancelling…"
			: "Stop"
		: pending === "send"
			? "Sending…"
			: "Send";
	const submit = async () => {
		setError(undefined);
		if (stopMode) {
			const running = queue.running;
			if (!running || running.state === "cancelling" || pending !== undefined) return;
			setPending("stop");
			try {
				const result = await onStop(running.turnId);
				if (!result.ok && !(result.status === 409 && result.error.code === "turn_unavailable")) {
					setError(result.error.message ?? result.error.code);
				}
			} catch (failure) {
				setError(failureMessage(failure));
			} finally {
				setPending(undefined);
			}
			return;
		}
		if (!hasText || pending !== undefined) return;
		const submitted = text;
		setPending("send");
		try {
			const result = await onSend(submitted);
			if (result.ok && result.status === 202) {
				setText("");
				return;
			}
			if (!result.ok && result.status === 409 && result.error.code === "context_exhausted") {
				setError("Context is exhausted. Compact the session, then try again.");
				return;
			}
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			setError(`Prompt admission returned HTTP ${result.status}`);
		} catch (failure) {
			setError(failureMessage(failure));
		} finally {
			setPending(undefined);
		}
	};
	const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		if (stopMode) return;
		void submit();
	};
	return (
		<form
			className="rounded-2xl border border-[var(--line)] bg-[var(--background)] p-2 shadow-[var(--shadow)] focus-within:border-[color-mix(in_srgb,var(--accent)_45%,var(--line))]"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="flex items-end gap-2">
				<textarea
					aria-label="Prompt"
					className="field-sizing-content max-h-48 min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-sm leading-6 text-[var(--text)] outline-none placeholder:text-[var(--faint)]"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={keyDown}
					placeholder="Ask ker to do something…"
					ref={textareaRef}
					rows={1}
					value={text}
				/>
				<button
					className={`grid min-w-20 place-items-center rounded-xl px-4 py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${stopMode ? "bg-red-600 text-white" : "bg-[var(--accent)] text-white"}`}
					disabled={disabled}
					type="submit"
				>
					{label}
				</button>
			</div>
			{error ? (
				<p className="px-3 pb-2 pt-1 text-xs text-red-700 dark:text-red-300" role="alert">
					{error}
				</p>
			) : null}
		</form>
	);
}

function failureMessage(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}
