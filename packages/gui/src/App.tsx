import { useEffect, useSyncExternalStore } from "react";
import { parseHash } from "./router.ts";
import { ProjectsScreen } from "./screens/projects.tsx";
import { SessionsScreen } from "./screens/sessions.tsx";
import { TranscriptScreen } from "./screens/transcript.tsx";

const subscribeHash = (listener: () => void) => {
	window.addEventListener("hashchange", listener);
	return () => window.removeEventListener("hashchange", listener);
};
const getHash = () => window.location.hash;

export function App() {
	const hash = useSyncExternalStore(subscribeHash, getHash);
	const route = parseHash(hash);
	useEffect(() => {
		if (!hash) window.location.replace("#/projects");
	}, [hash]);
	if (route.screen === "sessions") return <SessionsScreen projectId={route.projectId} />;
	if (route.screen === "transcript") {
		return <TranscriptScreen projectId={route.projectId} sessionId={route.sessionId} key={route.sessionId} />;
	}
	return <ProjectsScreen />;
}
