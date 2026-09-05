import type * as Protocol from "@ker-ai/protocol";
import { useCallback, useState } from "react";
import { api } from "../api.ts";
import { formatDate } from "../format.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { formatRoute } from "../router.ts";
import { ProjectHeader } from "./project-header.tsx";

interface DocumentsState {
	documents: Protocol.DocumentSummary[];
	loaded: boolean;
	error?: string;
}

export function DocumentsScreen({
	projectId,
	listDocuments = api.listDocuments,
	getProject = api.getProject,
	navigate,
}: {
	projectId: string;
	listDocuments?: typeof api.listDocuments;
	getProject?: typeof api.getProject;
	navigate?: (route: string) => void;
}) {
	const [state, setState] = useState<DocumentsState>({ documents: [], loaded: false });
	const refetch = useCallback(async () => {
		try {
			const result = await listDocuments(projectId);
			if (!result.ok) {
				setState((current) => ({ ...current, loaded: true, error: result.error.message ?? result.error.code }));
				return;
			}
			setState({ documents: result.value.documents, loaded: true });
		} catch (error) {
			setState((current) => ({
				...current,
				loaded: true,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}, [listDocuments, projectId]);
	useVisiblePoll(refetch);
	const newRoute = formatRoute({ screen: "document", projectId, documentId: "new" });

	return (
		<main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-8 sm:px-8 lg:px-12">
			<ProjectHeader
				action={
					<button
						className="shrink-0 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white"
						onClick={() => {
							if (navigate) {
								navigate(newRoute);
								return;
							}
							window.location.hash = newRoute;
						}}
						type="button"
					>
						New document
					</button>
				}
				getProject={getProject}
				projectId={projectId}
				tab="documents"
			/>

			{state.error ? (
				<section className="empty-panel border-red-500/25">
					<p className="text-red-700 dark:text-red-300">{state.error}</p>
					<button className="mt-3 text-sm font-semibold underline" onClick={refetch} type="button">
						Retry
					</button>
				</section>
			) : null}
			{!state.loaded ? <div className="surface-card h-56 animate-pulse bg-[var(--surface-muted)]" /> : null}
			{state.loaded && !state.error && state.documents.length === 0 ? (
				<section className="empty-panel">
					<p className="font-medium text-[var(--text)]">No documents yet</p>
				</section>
			) : null}
			{state.documents.length > 0 ? (
				<section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow)]">
					{state.documents.map((document) => (
						<a
							className="flex items-center justify-between gap-5 border-b border-[var(--line)] p-5 transition-colors last:border-0 hover:bg-[var(--surface-hover)]"
							href={formatRoute({ screen: "document", projectId, documentId: document.id })}
							key={document.id}
						>
							<div className="min-w-0">
								<h2 className="truncate font-medium text-[var(--text)]">{document.title}</h2>
								<p className="mt-2 truncate font-mono text-xs text-[var(--faint)]">{document.id}</p>
							</div>
							<p className="shrink-0 text-sm text-[var(--muted)]">{formatDate(document.updatedAt)}</p>
						</a>
					))}
				</section>
			) : null}
		</main>
	);
}
