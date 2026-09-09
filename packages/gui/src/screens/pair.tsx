import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api.ts";
import { auth } from "../store/auth.ts";

export function PairScreen({
	code,
	listDevices = api.listDevices,
	claimPairing = api.claimPairing,
}: {
	code: string;
	listDevices?: typeof api.listDevices;
	claimPairing?: typeof api.claimPairing;
}) {
	const [status, setStatus] = useState<"loading" | "paired" | "form" | "local">("loading");
	const [name, setName] = useState(() => deviceNameHint(navigator.userAgent));
	const [error, setError] = useState<string>();
	const [submitting, setSubmitting] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		void listDevices(controller.signal)
			.then((result) => {
				if (controller.signal.aborted) return;
				if (result.ok) {
					setStatus("paired");
					return;
				}
				if (result.status === 401) {
					setStatus("form");
					return;
				}
				setError(result.error.message ?? result.error.code);
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
			});
		return () => controller.abort();
	}, [listDevices]);
	const pair = async (event: FormEvent) => {
		event.preventDefault();
		if (submitting || !name.trim()) return;
		setSubmitting(true);
		setError(undefined);
		try {
			const result = await claimPairing({ code, name: name.trim() });
			if (result.ok) {
				auth.setPaired();
				window.location.replace("#/projects");
				return;
			}
			if (result.status === 409) {
				setStatus("local");
				return;
			}
			setError(
				result.status === 410
					? "This link expired or was already used. Ask for a new one."
					: (result.error.message ?? result.error.code),
			);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setSubmitting(false);
		}
	};
	return (
		<main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-10">
			<h1 className="text-3xl font-semibold tracking-tight text-[var(--text)]">
				{status === "paired" ? "This device is already paired" : "Pair this device"}
			</h1>
			{status === "loading" && !error ? <p className="mt-4 text-[var(--muted)]">Checking this device…</p> : null}
			{status === "paired" ? (
				<button
					className="mt-6 font-semibold text-[var(--accent)] underline"
					type="button"
					onClick={() => {
						auth.setPaired();
						window.location.replace("#/projects");
					}}
				>
					Continue
				</button>
			) : null}
			{status === "local" ? (
				<p className="mt-4 text-[var(--muted)]">Pairing is off: this server runs in local mode.</p>
			) : null}
			{status === "form" ? (
				<form className="mt-6 flex flex-col gap-4" onSubmit={(event) => void pair(event)}>
					<label className="text-sm font-medium text-[var(--text)]" htmlFor="device-name">
						Device name
					</label>
					<input
						className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-[var(--text)]"
						id="device-name"
						maxLength={80}
						onChange={(event) => setName(event.target.value)}
						required
						value={name}
					/>
					<button
						className="rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white disabled:opacity-50"
						disabled={submitting || !name.trim()}
						type="submit"
					>
						{submitting ? "Pairing…" : "Pair this device"}
					</button>
				</form>
			) : null}
			{error ? (
				<p className="mt-4 text-sm text-red-700 dark:text-red-300" role="alert">
					{error}
				</p>
			) : null}
		</main>
	);
}

export function deviceNameHint(userAgent: string): string {
	if (/iPhone/i.test(userAgent)) return "iPhone";
	if (/iPad/i.test(userAgent)) return "iPad";
	if (/Android/i.test(userAgent)) return "Android";
	if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
	if (/Windows/i.test(userAgent)) return "Windows";
	if (/Linux/i.test(userAgent)) return "Linux";
	return "My device";
}
