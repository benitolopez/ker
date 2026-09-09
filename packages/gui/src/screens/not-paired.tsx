export function NotPairedScreen() {
	return (
		<main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-10">
			<h1 className="text-3xl font-semibold tracking-tight text-[var(--text)]">This device is not paired</h1>
			<p className="mt-4 text-[var(--muted)]">
				Open a pairing link from a paired device, or run <code>ker pair</code> on the server.
			</p>
		</main>
	);
}
