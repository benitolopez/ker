import type * as Protocol from "@ker-ai/protocol";
import { useCallback, useState } from "react";
import { api } from "../api.ts";
import { formatDate } from "../format.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { formatRoute } from "../router.ts";

interface SessionsState {
	sessions: Protocol.CatalogSession[];
	loaded: boolean;
	error?: string;
}

export function SessionsScreen({ projectId }: { projectId: string }) {
	const [state, setState] = useState<SessionsState>({ sessions: [], loaded: false });
	const refetch = useCallback(async () => {
		try {
			const result = await api.listProjectSessions(projectId);
			if (!result.ok) {
				setState((current) => ({ ...current, loaded: true, error: result.error.message ?? result.error.code }));
				return;
			}
			setState({ sessions: result.value.sessions, loaded: true });
		} catch (error) {
			setState((current) => ({
				...current,
				loaded: true,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}, [projectId]);
	useVisiblePoll(refetch);
	const sessions = [...state.sessions].sort((left, right) =>
		(right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
	);
	const projectName = sessions.find((session) => session.projectName)?.projectName ?? "Project";

	return (
		<main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-8 sm:px-8 lg:px-12">
			<a className="back-link" href={formatRoute({ screen: "projects" })}>
				← Projects
			</a>
			<header className="mb-8 mt-6">
				<p className="mb-2 font-mono text-xs tracking-[0.18em] text-[var(--muted)] uppercase">Project</p>
				<h1 className="text-4xl font-semibold tracking-[-0.04em] text-[var(--text)]">{projectName}</h1>
				<p className="mt-3 font-mono text-xs text-[var(--faint)]">{projectId}</p>
			</header>

			{state.error ? (
				<section className="empty-panel border-red-500/25">
					<p className="text-red-700 dark:text-red-300">{state.error}</p>
					<button className="mt-3 text-sm font-semibold underline" onClick={refetch} type="button">
						Retry
					</button>
				</section>
			) : null}
			{!state.loaded ? <div className="surface-card h-56 animate-pulse bg-[var(--surface-muted)]" /> : null}
			{state.loaded && !state.error && sessions.length === 0 ? (
				<section className="empty-panel">
					<p className="font-medium text-[var(--text)]">No sessions in this project</p>
				</section>
			) : null}
			<section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow)]">
				{sessions.map((session) => {
					const content = (
						<>
							<div className="min-w-0">
								<div className="flex items-center gap-3">
									<StatusDot status={session.status} />
									<h2 className="truncate font-medium text-[var(--text)]">
										{session.title ?? (session.status === "unreadable" ? "Unreadable session" : "Untitled session")}
									</h2>
								</div>
								<p className="mt-2 truncate pl-5 font-mono text-xs text-[var(--faint)]">{session.id}</p>
								{session.status === "unreadable" ? (
									<p className="mt-2 pl-5 text-sm text-red-700 dark:text-red-300">{session.error}</p>
								) : null}
							</div>
							<div className="shrink-0 text-right">
								<p className="text-sm text-[var(--muted)]">{formatDate(session.updatedAt)}</p>
								<p className="mt-1 text-xs capitalize text-[var(--faint)]">{session.status}</p>
							</div>
						</>
					);
					const className = "flex items-center justify-between gap-5 border-b border-[var(--line)] p-5 last:border-0";
					if (session.status === "unreadable") {
						return (
							<div className={`${className} bg-red-500/[0.025]`} key={session.id}>
								{content}
							</div>
						);
					}
					return (
						<a
							className={`${className} transition-colors hover:bg-[var(--surface-hover)]`}
							href={formatRoute({ screen: "transcript", projectId, sessionId: session.id })}
							key={session.id}
						>
							{content}
						</a>
					);
				})}
			</section>
		</main>
	);
}

function StatusDot({ status }: { status: Protocol.CatalogSession["status"] }) {
	const color = status === "busy" ? "bg-amber-500" : status === "idle" ? "bg-emerald-500" : "bg-red-500";
	return <span className={`size-2 rounded-full ${color}`} title={status} />;
}
