import type { Client } from "@ker-ai/client";
import type { AuthMode } from "@ker-ai/protocol";
import { useSyncExternalStore } from "react";

interface AuthState {
	mode?: AuthMode;
	unpaired: boolean;
}

export function createAuthStore() {
	const state: { snapshot: AuthState; loading?: Promise<void> } = { snapshot: { unpaired: false } };
	const listeners = new Set<() => void>();
	const update = (next: AuthState) => {
		state.snapshot = next;
		for (const listener of listeners) listener();
	};
	return {
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => state.snapshot,
		load: (health: Client["health"]) => {
			state.loading ??= health()
				.then((result) => {
					if (result.ok) update({ ...state.snapshot, mode: result.value.auth });
				})
				.catch(() => undefined);
			return state.loading;
		},
		setUnpaired: () => update({ ...state.snapshot, unpaired: true }),
		setPaired: () => update({ ...state.snapshot, unpaired: false }),
	};
}

export const auth = createAuthStore();

export function useAuth() {
	return useSyncExternalStore(auth.subscribe, auth.getSnapshot);
}
