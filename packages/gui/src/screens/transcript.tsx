import { AttachError } from "@ker-ai/client";
import type * as Protocol from "@ker-ai/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
					{header ? <SessionHeader header={header} /> : <span className="status-pill">Connecting…</span>}
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
			<QueueStrip queue={view.queue} />
		</div>
	);
}

function SessionHeader({ header }: { header: NonNullable<ReturnType<TranscriptStore["getSnapshot"]>["header"]> }) {
	const window = header.model?.contextWindow;
	const percentage = window ? Math.min(100, (header.usage.contextTokens / window) * 100) : undefined;
	return (
		<div className="hidden items-center gap-5 text-right sm:flex">
			<div>
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

function QueueStrip({ queue }: { queue: Protocol.QueueSnapshot }) {
	const items = [queue.running, ...queue.waiting].filter((item) => item !== undefined);
	if (items.length === 0) return null;
	return (
		<aside className="border-t border-[var(--line)] bg-[var(--surface)] px-5 py-3 sm:px-8">
			<div className="mx-auto flex max-w-5xl items-center gap-3 overflow-x-auto">
				<span className="shrink-0 font-mono text-[10px] font-semibold tracking-[0.16em] text-[var(--muted)] uppercase">
					Queue
				</span>
				{items.map((item) => (
					<div
						className="shrink-0 rounded-full border border-[var(--line)] px-3 py-1.5 text-xs text-[var(--muted)]"
						key={item.id}
					>
						<span className="mr-2 capitalize text-[var(--text)]">{item.state}</span>
						{item.kind === "prompt" ? item.text : `${item.source} compaction`}
					</div>
				))}
			</div>
		</aside>
	);
}
