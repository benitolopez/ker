import type * as Protocol from "@ker-ai/protocol";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { api } from "../api.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { Markdown } from "../markdown.tsx";
import { formatRoute } from "../router.ts";

export function DocumentScreen({
	projectId,
	documentId,
	getDocument = api.getDocument,
	createDocument = api.createDocument,
	updateDocument = api.updateDocument,
	deleteDocument = api.deleteDocument,
	navigate,
}: {
	projectId: string;
	documentId: string;
	getDocument?: typeof api.getDocument;
	createDocument?: typeof api.createDocument;
	updateDocument?: typeof api.updateDocument;
	deleteDocument?: typeof api.deleteDocument;
	navigate?: (route: string) => void;
}) {
	const isNew = documentId === "new";
	const [document, setDocument] = useState<Protocol.Document>();
	const [loaded, setLoaded] = useState(isNew);
	const [editing, setEditing] = useState(isNew);
	const editingRef = useRef(isNew);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [error, setError] = useState<string>();
	const refetch = useCallback(async () => {
		if (isNew || editingRef.current) return;
		try {
			const result = await getDocument(documentId);
			if (!result.ok) {
				setLoaded(true);
				setError(result.error.message ?? result.error.code);
				return;
			}
			setDocument(result.value);
			if (!editingRef.current) {
				setTitle(result.value.title);
				setBody(result.value.body);
			}
			setLoaded(true);
			setError(undefined);
		} catch (failure) {
			setLoaded(true);
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}, [documentId, getDocument, isNew]);
	useVisiblePoll(refetch);
	const listRoute = formatRoute({ screen: "documents", projectId });
	const changed = isNew || title !== document?.title || body !== document?.body;
	const saveDisabled = saving || title.trim().length === 0 || !changed;
	const go = (route: string, replace = false) => {
		if (navigate) {
			navigate(route);
			return;
		}
		if (replace) {
			window.location.replace(route);
			return;
		}
		window.location.hash = route;
	};
	const cancel = () => {
		if (isNew) {
			go(listRoute);
			return;
		}
		setTitle(document?.title ?? "");
		setBody(document?.body ?? "");
		setError(undefined);
		editingRef.current = false;
		setEditing(false);
	};
	const save = async () => {
		if (saveDisabled) return;
		setSaving(true);
		setError(undefined);
		try {
			const input: Protocol.DocumentRequest = { title, body };
			const result = isNew ? await createDocument(projectId, input) : await updateDocument(documentId, input);
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			setDocument(result.value);
			setTitle(result.value.title);
			setBody(result.value.body);
			editingRef.current = false;
			setEditing(false);
			if (isNew) {
				go(formatRoute({ screen: "document", projectId, documentId: result.value.id }), true);
			}
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setSaving(false);
		}
	};
	const remove = async () => {
		setDeleting(true);
		setError(undefined);
		try {
			const result = await deleteDocument(documentId);
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			go(listRoute);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setDeleting(false);
		}
	};
	const keyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			cancel();
			return;
		}
		if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
		event.preventDefault();
		void save();
	};

	return (
		<main
			className="mx-auto min-h-screen w-full max-w-4xl px-5 py-8 sm:px-8 lg:px-12"
			onKeyDown={editing ? keyDown : undefined}
		>
			<a className="back-link" href={listRoute}>
				← Documents
			</a>
			{!loaded ? <div className="surface-card mt-6 h-72 animate-pulse bg-[var(--surface-muted)]" /> : null}
			{loaded && !document && !isNew ? (
				<section className="empty-panel mt-6 border-red-500/25">
					<p className="text-red-700 dark:text-red-300">{error ?? "Document not found"}</p>
					<button className="mt-3 text-sm font-semibold underline" onClick={refetch} type="button">
						Retry
					</button>
				</section>
			) : null}
			{loaded && (document || isNew) ? (
				<>
					<header className="mb-8 mt-6 flex flex-wrap items-start justify-between gap-5">
						<div className="min-w-0 flex-1">
							<p className="mb-2 font-mono text-xs tracking-[0.18em] text-[var(--muted)] uppercase">
								{isNew ? "New document" : "Document"}
							</p>
							{editing ? (
								<input
									aria-label="Title"
									className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-2xl font-semibold text-[var(--text)] outline-none focus:border-[var(--accent)]"
									maxLength={200}
									onChange={(event) => setTitle(event.target.value)}
									placeholder="Document title"
									value={title}
								/>
							) : (
								<h1 className="break-words text-4xl font-semibold tracking-[-0.04em] text-[var(--text)]">
									{document?.title}
								</h1>
							)}
							{document ? <p className="mt-3 truncate font-mono text-xs text-[var(--faint)]">{document.id}</p> : null}
						</div>
						<div className="flex flex-wrap items-center justify-end gap-2">
							{editing ? (
								<>
									<button
										className="rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--muted)]"
										onClick={cancel}
										type="button"
									>
										Cancel
									</button>
									<button
										className="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
										disabled={saveDisabled}
										onClick={() => void save()}
										type="button"
									>
										{saving ? "Saving…" : "Save"}
									</button>
								</>
							) : confirmingDelete ? (
								<>
									<span className="text-sm text-[var(--muted)]">Delete this document?</span>
									<button
										className="rounded-xl px-3 py-2 text-sm font-semibold text-[var(--muted)]"
										onClick={() => setConfirmingDelete(false)}
										type="button"
									>
										Cancel
									</button>
									<button
										className="rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-45"
										disabled={deleting}
										onClick={() => void remove()}
										type="button"
									>
										{deleting ? "Deleting…" : "Confirm"}
									</button>
								</>
							) : (
								<>
									<button
										className="rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm font-semibold text-[var(--muted)]"
										onClick={() => {
											setTitle(document?.title ?? "");
											setBody(document?.body ?? "");
											setError(undefined);
											editingRef.current = true;
											setEditing(true);
										}}
										type="button"
									>
										Edit
									</button>
									<button
										className="rounded-xl px-4 py-2.5 text-sm font-semibold text-red-700 dark:text-red-300"
										onClick={() => setConfirmingDelete(true)}
										type="button"
									>
										Delete
									</button>
								</>
							)}
						</div>
					</header>
					{editing ? (
						<section>
							<textarea
								aria-label="Body"
								className="min-h-[28rem] w-full resize-y rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 font-mono text-sm leading-7 text-[var(--text)] outline-none shadow-[var(--shadow)] focus:border-[var(--accent)]"
								onChange={(event) => setBody(event.target.value)}
								placeholder="Write Markdown…"
								value={body}
							/>
						</section>
					) : (
						<article className="surface-card min-h-64 p-6 sm:p-8">
							<Markdown text={document?.body ?? ""} />
						</article>
					)}
					{error ? (
						<p className="mt-4 text-sm text-red-700 dark:text-red-300" role="alert">
							{error}
						</p>
					) : null}
				</>
			) : null}
		</main>
	);
}
