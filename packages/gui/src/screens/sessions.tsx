import type * as Protocol from "@ker-ai/protocol";
import { type FormEvent, useCallback, useState } from "react";
import { api } from "../api.ts";
import { formatDate } from "../format.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { formatRoute } from "../router.ts";
import { ProjectHeader } from "./project-header.tsx";

interface SessionsState {
	sessions: Protocol.CatalogSession[];
	loaded: boolean;
	error?: string;
}

export function SessionsScreen({
	projectId,
	listProjectSessions = api.listProjectSessions,
	createProjectSession = api.createProjectSession,
	listWorkspaces = api.listWorkspaces,
	createWorkspace = api.createWorkspace,
	getProject = api.getProject,
	navigate,
}: {
	projectId: string;
	listProjectSessions?: typeof api.listProjectSessions;
	createProjectSession?: typeof api.createProjectSession;
	listWorkspaces?: typeof api.listWorkspaces;
	createWorkspace?: typeof api.createWorkspace;
	getProject?: typeof api.getProject;
	navigate?: (route: string) => void;
}) {
	const [state, setState] = useState<SessionsState>({ sessions: [], loaded: false });
	const [creating, setCreating] = useState(false);
	const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
	const refetch = useCallback(async () => {
		try {
			const result = await listProjectSessions(projectId);
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
	}, [listProjectSessions, projectId]);
	useVisiblePoll(refetch);
	const createSession = async () => {
		setCreating(true);
		setState((current) => ({ ...current, error: undefined }));
		try {
			const result = await createProjectSession(projectId);
			if (!result.ok) {
				setState((current) => ({ ...current, error: sessionErrorMessage(result.error) }));
				if (result.error.code === "workspace_missing") setWorkspaceRefresh((value) => value + 1);
				setCreating(false);
				return;
			}
			const route = formatRoute({ screen: "transcript", projectId, sessionId: result.value.id });
			setCreating(false);
			if (navigate) {
				navigate(route);
				return;
			}
			window.location.hash = route;
		} catch (error) {
			setState((current) => ({
				...current,
				error: error instanceof Error ? error.message : String(error),
			}));
			setCreating(false);
		}
	};
	const sessions = [...state.sessions].sort((left, right) =>
		(right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
	);

	return (
		<main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-8 sm:px-8 lg:px-12">
			<ProjectHeader
				action={
					<button
						className="shrink-0 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
						disabled={creating}
						onClick={() => void createSession()}
						type="button"
					>
						{creating ? "Creating…" : "New session"}
					</button>
				}
				getProject={getProject}
				projectId={projectId}
				tab="sessions"
			/>
			<FoldersStrip
				createWorkspace={createWorkspace}
				key={workspaceRefresh}
				listWorkspaces={listWorkspaces}
				projectId={projectId}
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

export function FoldersStrip({
	projectId,
	listWorkspaces,
	createWorkspace,
}: {
	projectId: string;
	listWorkspaces: typeof api.listWorkspaces;
	createWorkspace: typeof api.createWorkspace;
}) {
	const [workspaces, setWorkspaces] = useState<Protocol.Workspace[]>([]);
	const [path, setPath] = useState("");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string>();
	const refetch = useCallback(async () => {
		try {
			const result = await listWorkspaces(projectId);
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			setWorkspaces(result.value.workspaces);
			setError(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, [listWorkspaces, projectId]);
	useVisiblePoll(refetch);
	const add = async (event: FormEvent) => {
		event.preventDefault();
		if (!path.trim() || adding) return;
		setAdding(true);
		setError(undefined);
		try {
			const result = await createWorkspace(projectId, { path: path.trim() });
			if (!result.ok) {
				setError(workspaceErrorMessage(result.error));
				return;
			}
			setPath("");
			await refetch();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setAdding(false);
		}
	};
	const sorted = [...workspaces].sort((left, right) => {
		if (left.exists !== right.exists) return left.exists ? -1 : 1;
		return left.rootPath.localeCompare(right.rootPath);
	});

	return (
		<section className="mb-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
			<h2 className="text-sm font-semibold text-[var(--text)]">Folders</h2>
			<div className="mt-3 grid gap-2">
				{sorted.map((workspace) => (
					<div className="flex flex-wrap items-center justify-between gap-2 text-sm" key={workspace.id}>
						<span className="break-all font-mono text-xs text-[var(--muted)]">{workspace.rootPath}</span>
						<span className={workspace.exists ? "text-xs text-[var(--faint)]" : "text-xs font-semibold text-amber-600"}>
							{workspace.exists ? (workspace.gitRemote ? `git: ${workspace.gitRemote}` : "") : "missing"}
						</span>
					</div>
				))}
			</div>
			<form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => void add(event)}>
				<input
					aria-label="Folder path"
					className="min-w-0 flex-1 rounded-xl border border-[var(--line)] bg-[var(--background)] px-3 py-2 font-mono text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
					disabled={adding}
					onChange={(event) => setPath(event.currentTarget.value)}
					placeholder="/absolute/path"
					value={path}
				/>
				<button
					className="rounded-xl border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-45"
					disabled={adding || !path.trim()}
					type="submit"
				>
					{adding ? "Adding…" : "Add folder"}
				</button>
			</form>
			{error ? (
				<p className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">
					{error}
				</p>
			) : null}
		</section>
	);
}

function sessionErrorMessage(error: Protocol.ErrorBody): string {
	if (error.code === "workspace_missing") {
		return "None of this project's folders exist on this node. Add one below.";
	}
	if (error.code === "workspace_ambiguous") {
		return "More than one folder exists on this node; choosing one is not supported yet.";
	}
	return error.message ?? error.code;
}

function workspaceErrorMessage(error: Protocol.ErrorBody): string {
	if (error.code === "invalid_workspace") return "Enter an absolute path to an existing folder.";
	return error.message ?? error.code;
}

function StatusDot({ status }: { status: Protocol.CatalogSession["status"] }) {
	const color = status === "busy" ? "bg-amber-500" : status === "idle" ? "bg-emerald-500" : "bg-red-500";
	return <span className={`size-2 rounded-full ${color}`} title={status} />;
}
