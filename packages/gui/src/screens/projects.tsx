import type * as Protocol from "@ker-ai/protocol";
import { type ChangeEvent, useCallback, useState } from "react";
import { api } from "../api.ts";
import { formatDate } from "../format.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { formatRoute } from "../router.ts";

interface ProjectsState {
	projects: Protocol.Project[];
	loaded: boolean;
	error?: string;
}

type ImportState = { kind: "success"; result: Protocol.ImportResult } | { kind: "error"; message: string };

export function ProjectsScreen({
	listProjects = api.listProjects,
	importProject = api.importProject,
}: {
	listProjects?: typeof api.listProjects;
	importProject?: typeof api.importProject;
} = {}) {
	const [state, setState] = useState<ProjectsState>({ projects: [], loaded: false });
	const [importing, setImporting] = useState(false);
	const [importState, setImportState] = useState<ImportState>();
	const refetch = useCallback(async () => {
		try {
			const result = await listProjects();
			if (!result.ok) {
				setState((current) => ({ ...current, loaded: true, error: result.error.message ?? result.error.code }));
				return;
			}
			setState({ projects: result.value.projects, loaded: true });
		} catch (error) {
			setState((current) => ({
				...current,
				loaded: true,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}, [listProjects]);
	useVisiblePoll(refetch);
	const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
		const archive = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (!archive) return;
		setImporting(true);
		setImportState(undefined);
		try {
			const result = await importProject(archive);
			if (!result.ok) {
				setImportState({ kind: "error", message: importErrorMessage(result.error) });
				return;
			}
			setImportState({ kind: "success", result: result.value });
			await refetch();
		} catch (error) {
			setImportState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
		} finally {
			setImporting(false);
		}
	};
	const projects = [...state.projects].sort((left, right) => {
		if (!left.lastActivityAt && !right.lastActivityAt) return 0;
		if (!left.lastActivityAt) return 1;
		if (!right.lastActivityAt) return -1;
		return right.lastActivityAt.localeCompare(left.lastActivityAt);
	});

	return (
		<main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-10 sm:px-8 lg:px-12">
			<header className="mb-10 flex items-end justify-between gap-6">
				<div>
					<p className="mb-2 font-mono text-xs font-semibold tracking-[0.22em] text-[var(--muted)] uppercase">
						Control plane
					</p>
					<h1 className="text-4xl font-semibold tracking-[-0.04em] text-[var(--text)] sm:text-5xl">Projects</h1>
				</div>
				<div className="flex items-center gap-3">
					<a
						className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--text)] shadow-[var(--shadow)]"
						href={formatRoute({ screen: "nodes" })}
					>
						Nodes
					</a>
					<label className="cursor-pointer rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--text)] shadow-[var(--shadow)]">
						{importing ? "Importing…" : "Import"}
						<input
							accept=".zip,application/zip"
							className="sr-only"
							disabled={importing}
							onChange={(event) => void onPick(event)}
							type="file"
						/>
					</label>
					<div className="status-pill">
						<span className="size-2 rounded-full bg-emerald-500" />
						Live
					</div>
				</div>
			</header>

			{importState ? <ImportPanel state={importState} /> : null}
			{state.error ? <ErrorPanel message={state.error} retry={refetch} /> : null}
			{!state.loaded ? <LoadingRows /> : null}
			{state.loaded && !state.error && projects.length === 0 ? (
				<section className="empty-panel">
					<p className="text-lg font-medium text-[var(--text)]">No projects yet</p>
					<p className="mt-2 text-sm text-[var(--muted)]">Start a session from a folder or import an archive.</p>
				</section>
			) : null}
			<section className="grid gap-4 md:grid-cols-2">
				{projects.map((project) => (
					<a
						className="group surface-card flex min-h-44 flex-col justify-between p-6"
						href={formatRoute({ screen: "sessions", projectId: project.id })}
						key={project.id}
					>
						<div className="flex items-start justify-between gap-4">
							<div className="grid size-11 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
								<ProjectGlyph />
							</div>
							<span className="text-xl text-[var(--muted)] transition-transform group-hover:translate-x-1">→</span>
						</div>
						<div>
							<h2 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">{project.name}</h2>
							<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--muted)]">
								<span>
									{project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
								</span>
								<span>{formatDate(project.lastActivityAt)}</span>
							</div>
						</div>
					</a>
				))}
			</section>
			<footer className="mt-auto pt-12 font-mono text-xs text-[var(--faint)]">ker · control plane</footer>
		</main>
	);
}

function ImportPanel({ state }: { state: ImportState }) {
	if (state.kind === "error") {
		return (
			<section className="mb-5 rounded-2xl border border-red-500/25 bg-red-500/8 p-5 text-sm text-red-700 dark:text-red-300">
				{state.message}
			</section>
		);
	}
	const result = state.result;
	const skipped = result.documents.skipped + result.sessions.skipped;
	return (
		<section className="mb-5 rounded-2xl border border-emerald-500/25 bg-emerald-500/8 p-5 text-sm text-[var(--text)]">
			<p>
				Imported {result.project.name}: {result.documents.imported} documents, {result.sessions.imported} sessions
				{result.sessions.unreadable ? ` (${result.sessions.unreadable} unreadable)` : ""}
				{skipped ? `, ${skipped} skipped` : ""}
			</p>
			<a
				className="mt-3 inline-block font-semibold text-[var(--accent)] underline underline-offset-4"
				href={formatRoute({ screen: "sessions", projectId: result.project.id })}
			>
				Open project
			</a>
		</section>
	);
}

function importErrorMessage(error: Protocol.ErrorBody): string {
	if (error.code === "unsupported_archive") return "This archive was made by a newer ker.";
	if (error.code === "invalid_archive") {
		return `This file is not a ker archive.${error.message ? ` ${error.message}` : ""}`;
	}
	return error.message ?? error.code;
}

function ProjectGlyph() {
	return (
		<svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
			<path d="M4 7.5h6l2-2h8v13H4z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
		</svg>
	);
}

function LoadingRows() {
	return (
		<section className="grid gap-4 md:grid-cols-2">
			{[0, 1, 2, 3].map((index) => (
				<div className="surface-card h-44 animate-pulse bg-[var(--surface-muted)]" key={index} />
			))}
		</section>
	);
}

function ErrorPanel({ message, retry }: { message: string; retry: () => void }) {
	return (
		<section className="mb-5 rounded-2xl border border-red-500/25 bg-red-500/8 p-5 text-sm text-red-700 dark:text-red-300">
			<p>{message}</p>
			<button className="mt-3 font-semibold underline underline-offset-4" onClick={retry} type="button">
				Retry
			</button>
		</section>
	);
}
