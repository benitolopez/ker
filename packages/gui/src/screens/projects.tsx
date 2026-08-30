import type * as Protocol from "@ker-ai/protocol";
import { useCallback, useState } from "react";
import { api } from "../api.ts";
import { formatDate } from "../format.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { formatRoute } from "../router.ts";

interface ProjectsState {
	projects: Protocol.Project[];
	loaded: boolean;
	error?: string;
}

export function ProjectsScreen() {
	const [state, setState] = useState<ProjectsState>({ projects: [], loaded: false });
	const refetch = useCallback(async () => {
		try {
			const result = await api.listProjects();
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
	}, []);
	useVisiblePoll(refetch);
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
				<div className="status-pill">
					<span className="size-2 rounded-full bg-emerald-500" />
					Live
				</div>
			</header>

			{state.error ? <ErrorPanel message={state.error} retry={refetch} /> : null}
			{!state.loaded ? <LoadingRows /> : null}
			{state.loaded && !state.error && projects.length === 0 ? (
				<section className="empty-panel">
					<p className="text-lg font-medium text-[var(--text)]">No projects yet</p>
					<p className="mt-2 text-sm text-[var(--muted)]">Start a session from the CLI and it will appear here.</p>
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
			<footer className="mt-auto pt-12 font-mono text-xs text-[var(--faint)]">ker · read-only surface</footer>
		</main>
	);
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
