export interface PollEnvironment {
	isVisible(): boolean;
	setInterval(callback: () => void, intervalMs: number): unknown;
	clearInterval(handle: unknown): void;
	onFocus(callback: () => void): () => void;
	onVisibilityChange(callback: () => void): () => void;
}

export function startVisiblePoll(
	refetch: () => Promise<void> | void,
	options: { intervalMs?: number; environment?: PollEnvironment } = {},
): () => void {
	const environment = options.environment ?? browserPollEnvironment;
	let active = true;
	let fetching = false;
	const refresh = () => {
		if (!active || fetching || !environment.isVisible()) return;
		fetching = true;
		void Promise.resolve(refetch()).finally(() => {
			fetching = false;
		});
	};
	const interval = environment.setInterval(refresh, options.intervalMs ?? 5_000);
	const removeFocus = environment.onFocus(refresh);
	const removeVisibility = environment.onVisibilityChange(refresh);
	refresh();
	return () => {
		active = false;
		environment.clearInterval(interval);
		removeFocus();
		removeVisibility();
	};
}

const browserPollEnvironment: PollEnvironment = {
	isVisible: () => document.visibilityState === "visible",
	setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
	clearInterval: (handle) => window.clearInterval(handle as number),
	onFocus: (callback) => {
		window.addEventListener("focus", callback);
		return () => window.removeEventListener("focus", callback);
	},
	onVisibilityChange: (callback) => {
		document.addEventListener("visibilitychange", callback);
		return () => document.removeEventListener("visibilitychange", callback);
	},
};
