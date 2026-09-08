import type * as Protocol from "@ker-ai/protocol";
import { useCallback, useRef, useState } from "react";
import { api } from "../api.ts";
import { formatDate } from "../format.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { formatRoute } from "../router.ts";

export function NodesScreen({
	listNodes = api.listNodes,
	createEnrollment = api.createEnrollment,
	revokeNode = api.revokeNode,
}: {
	listNodes?: typeof api.listNodes;
	createEnrollment?: typeof api.createEnrollment;
	revokeNode?: typeof api.revokeNode;
} = {}) {
	const [nodes, setNodes] = useState<Protocol.Node[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string>();
	const [enrollment, setEnrollment] = useState<Protocol.Enrollment>();
	const [confirming, setConfirming] = useState<Protocol.NodeId>();
	const [copyStatus, setCopyStatus] = useState<string>();
	const commandRef = useRef<HTMLPreElement>(null);
	const refetch = useCallback(async () => {
		try {
			const result = await listNodes();
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				setLoaded(true);
				return;
			}
			setNodes(result.value.nodes);
			setError(undefined);
			setLoaded(true);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			setLoaded(true);
		}
	}, [listNodes]);
	useVisiblePoll(refetch);
	const enroll = async () => {
		setError(undefined);
		try {
			const result = await createEnrollment();
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			setEnrollment(result.value);
			setCopyStatus(undefined);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};
	const revoke = async (nodeId: Protocol.NodeId) => {
		try {
			const result = await revokeNode(nodeId);
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			setConfirming(undefined);
			await refetch();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};
	const copyCommand = async () => {
		if (!enrollment) return;
		try {
			if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
			await navigator.clipboard.writeText(enrollment.command);
			setCopyStatus("Copied");
			return;
		} catch {
			const command = commandRef.current;
			const selection = window.getSelection();
			if (!command || !selection) return;
			const range = document.createRange();
			range.selectNodeContents(command);
			selection.removeAllRanges();
			selection.addRange(range);
			setCopyStatus("Command selected");
		}
	};

	return (
		<main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-8 sm:px-8 lg:px-12">
			<a className="back-link" href={formatRoute({ screen: "projects" })}>
				← Projects
			</a>
			<header className="mt-6 mb-8 flex items-end justify-between gap-5">
				<div>
					<p className="mb-2 font-mono text-xs tracking-[0.18em] text-[var(--muted)] uppercase">Control plane</p>
					<h1 className="text-4xl font-semibold tracking-[-0.04em] text-[var(--text)]">Nodes</h1>
				</div>
				<button
					className="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white"
					onClick={() => void enroll()}
					type="button"
				>
					Enroll node
				</button>
			</header>
			{enrollment ? (
				<section className="mb-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
					<p className="text-sm text-[var(--muted)]">
						This enrollment expires in 15 minutes ({formatDate(enrollment.expiresAt)}).
					</p>
					<pre
						className="mt-3 overflow-x-auto rounded-xl bg-[var(--code)] p-4 font-mono text-xs text-[var(--text)]"
						ref={commandRef}
					>
						{enrollment.command}
					</pre>
					<div className="mt-3 flex items-center gap-3">
						<button className="text-sm font-semibold underline" onClick={() => void copyCommand()} type="button">
							Copy command
						</button>
						{copyStatus ? <span className="text-xs text-[var(--muted)]">{copyStatus}</span> : null}
					</div>
				</section>
			) : null}
			{error ? <p className="mb-5 text-sm text-red-700 dark:text-red-300">{error}</p> : null}
			{!loaded ? <div className="surface-card h-32 animate-pulse bg-[var(--surface-muted)]" /> : null}
			{loaded && nodes.length === 0 ? <section className="empty-panel">No nodes yet.</section> : null}
			<section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow)]">
				{nodes.map((node) => (
					<div
						className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] p-5 last:border-0"
						key={node.id}
					>
						<div>
							<h2 className="font-semibold text-[var(--text)]">{node.name}</h2>
							<p className="mt-1 font-mono text-xs text-[var(--faint)]">{node.id}</p>
							<p className="status-pill mt-2 inline-block">
								{node.connected
									? "Connected"
									: node.lastSeenAt
										? `Offline · last seen ${formatDate(node.lastSeenAt)}`
										: "Never connected"}
							</p>
						</div>
						{node.local ? (
							<span className="text-xs font-semibold text-[var(--muted)]">This machine</span>
						) : node.revokedAt ? (
							<span className="text-xs font-semibold text-red-600">Revoked</span>
						) : confirming === node.id ? (
							<div className="flex flex-wrap items-center justify-end gap-2 text-sm">
								<span>Revoke {node.name}?</span>
								<button className="font-semibold text-red-600" onClick={() => void revoke(node.id)} type="button">
									Confirm revoke
								</button>
								<button className="text-[var(--muted)]" onClick={() => setConfirming(undefined)} type="button">
									Cancel
								</button>
							</div>
						) : (
							<button
								className="text-sm font-semibold text-red-600"
								onClick={() => setConfirming(node.id)}
								type="button"
							>
								Revoke
							</button>
						)}
					</div>
				))}
			</section>
		</main>
	);
}
