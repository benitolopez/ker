import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { formatRoute } from "../router.ts";

export function ProjectHeader({
	projectId,
	tab,
	action,
	getProject = api.getProject,
	exportProjectPath = api.exportProjectPath,
}: {
	projectId: string;
	tab: "sessions" | "documents";
	action?: ReactNode;
	getProject?: typeof api.getProject;
	exportProjectPath?: typeof api.exportProjectPath;
}) {
	const [name, setName] = useState(projectId);
	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const result = await getProject(projectId, controller.signal);
				if (result.ok && !controller.signal.aborted) setName(result.value.name);
			} catch {
				return;
			}
		})();
		return () => controller.abort();
	}, [getProject, projectId]);

	return (
		<>
			<a className="back-link" href={formatRoute({ screen: "projects" })}>
				← Projects
			</a>
			<header className="mt-6 flex items-end justify-between gap-5">
				<div className="min-w-0">
					<p className="mb-2 font-mono text-xs tracking-[0.18em] text-[var(--muted)] uppercase">Project</p>
					<h1 className="truncate text-4xl font-semibold tracking-[-0.04em] text-[var(--text)]">{name}</h1>
					<p className="mt-3 truncate font-mono text-xs text-[var(--faint)]">{projectId}</p>
				</div>
				<div className="flex shrink-0 items-center gap-3">
					<a
						className="text-sm font-semibold text-[var(--muted)] hover:text-[var(--accent)]"
						download
						href={exportProjectPath(projectId)}
					>
						Export
					</a>
					{action}
				</div>
			</header>
			<nav className="mb-8 mt-7 flex gap-5 border-b border-[var(--line)]" aria-label="Project sections">
				<a
					aria-current={tab === "sessions" ? "page" : undefined}
					className={`border-b-2 px-1 pb-3 text-sm font-semibold ${tab === "sessions" ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"}`}
					href={formatRoute({ screen: "sessions", projectId })}
				>
					Sessions
				</a>
				<a
					aria-current={tab === "documents" ? "page" : undefined}
					className={`border-b-2 px-1 pb-3 text-sm font-semibold ${tab === "documents" ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"}`}
					href={formatRoute({ screen: "documents", projectId })}
				>
					Documents
				</a>
			</nav>
		</>
	);
}
