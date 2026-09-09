import type * as Protocol from "@ker-ai/protocol";
import QRCode from "qrcode";
import { useCallback, useRef, useState } from "react";
import { api } from "../api.ts";
import { formatDate } from "../format.ts";
import { useVisiblePoll } from "../hooks/use-visible-poll.ts";
import { formatRoute } from "../router.ts";
import { auth } from "../store/auth.ts";

export function DevicesScreen({
	listDevices = api.listDevices,
	createPairing = api.createPairing,
	revokeDevice = api.revokeDevice,
}: {
	listDevices?: typeof api.listDevices;
	createPairing?: typeof api.createPairing;
	revokeDevice?: typeof api.revokeDevice;
} = {}) {
	const [devices, setDevices] = useState<Protocol.Device[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string>();
	const [qr, setQr] = useState<string>();
	const [pairingBusy, setPairingBusy] = useState(false);
	const [revoking, setRevoking] = useState(false);
	const [pairing, setPairing] = useState<Protocol.Pairing>();
	const [confirming, setConfirming] = useState<Protocol.DeviceId>();
	const [copyStatus, setCopyStatus] = useState<string>();
	const linkRef = useRef<HTMLPreElement>(null);
	const refetch = useCallback(async () => {
		try {
			const result = await listDevices();
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				setLoaded(true);
				return;
			}
			setDevices(result.value.devices);
			setError(undefined);
			setLoaded(true);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			setLoaded(true);
		}
	}, [listDevices]);
	useVisiblePoll(refetch);
	const pair = async () => {
		if (pairingBusy) return;
		setPairingBusy(true);
		setError(undefined);
		try {
			const result = await createPairing();
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			setPairing(result.value);
			setQr(undefined);
			setQr(await QRCode.toDataURL(result.value.url));
			setCopyStatus(undefined);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setPairingBusy(false);
		}
	};
	const revoke = async (deviceId: Protocol.DeviceId) => {
		if (revoking) return;
		setRevoking(true);
		try {
			const result = await revokeDevice(deviceId);
			if (!result.ok) {
				setError(result.error.message ?? result.error.code);
				return;
			}
			setConfirming(undefined);
			if (result.value.current || devices.find((device) => device.id === deviceId)?.current) {
				auth.setUnpaired();
				return;
			}
			await refetch();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setRevoking(false);
		}
	};
	const copyLink = async () => {
		if (!pairing) return;
		try {
			if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
			await navigator.clipboard.writeText(pairing.url);
			setCopyStatus("Copied");
			return;
		} catch {
			const link = linkRef.current;
			const selection = window.getSelection();
			if (!link || !selection) return;
			const range = document.createRange();
			range.selectNodeContents(link);
			selection.removeAllRanges();
			selection.addRange(range);
			setCopyStatus("Link selected");
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
					<h1 className="text-4xl font-semibold tracking-[-0.04em] text-[var(--text)]">Devices</h1>
				</div>
				<button
					className="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white"
					disabled={pairingBusy}
					onClick={() => void pair()}
					type="button"
				>
					Pair device
				</button>
			</header>
			{pairing ? (
				<section className="mb-6 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
					<p className="text-sm text-[var(--muted)]">
						This link expires in 15 minutes ({formatDate(pairing.expiresAt)}).
					</p>
					<pre
						className="mt-3 overflow-x-auto rounded-xl bg-[var(--code)] p-4 font-mono text-xs text-[var(--text)]"
						ref={linkRef}
					>
						{pairing.url}
					</pre>
					{qr ? (
						<img alt="Pairing QR code" className="mt-4 max-w-full rounded-xl" height={256} src={qr} width={256} />
					) : null}
					<div className="mt-3 flex items-center gap-3">
						<button className="text-sm font-semibold underline" onClick={() => void copyLink()} type="button">
							Copy link
						</button>
						{copyStatus ? <span className="text-xs text-[var(--muted)]">{copyStatus}</span> : null}
					</div>
				</section>
			) : null}
			{error ? <p className="mb-5 text-sm text-red-700 dark:text-red-300">{error}</p> : null}
			{!loaded ? <div className="surface-card h-32 animate-pulse bg-[var(--surface-muted)]" /> : null}
			{loaded && devices.length === 0 ? <section className="empty-panel">No paired devices yet.</section> : null}
			<section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow)]">
				{devices.map((device) => (
					<div
						className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] p-5 last:border-0"
						key={device.id}
					>
						<div>
							<h2 className="font-semibold text-[var(--text)]">{device.name}</h2>
							<p className="mt-1 font-mono text-xs text-[var(--faint)]">{device.id}</p>
							{device.current ? <p className="status-pill mt-2 inline-block">This device</p> : null}
							<p className="mt-2 text-xs text-[var(--muted)]">Paired {formatDate(device.createdAt)}</p>
							<p className="mt-1 text-xs text-[var(--muted)]">Last seen {formatDate(device.lastSeenAt)}</p>
						</div>
						{confirming === device.id ? (
							<div className="flex flex-wrap items-center justify-end gap-2 text-sm">
								<span>Revoke {device.name}?</span>
								<button
									className="font-semibold text-red-600"
									disabled={revoking}
									onClick={() => void revoke(device.id)}
									type="button"
								>
									Confirm revoke
								</button>
								<button className="text-[var(--muted)]" onClick={() => setConfirming(undefined)} type="button">
									Cancel
								</button>
							</div>
						) : (
							<button
								className="text-sm font-semibold text-red-600"
								onClick={() => setConfirming(device.id)}
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
