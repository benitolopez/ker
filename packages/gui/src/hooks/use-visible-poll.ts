import { useEffect } from "react";
import { startVisiblePoll } from "../store/poll.ts";

export function useVisiblePoll(refetch: () => Promise<void> | void): void {
	useEffect(() => startVisiblePoll(refetch), [refetch]);
}
