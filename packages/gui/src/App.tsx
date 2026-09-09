import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { parseHash } from "./router.ts";
import { DevicesScreen } from "./screens/devices.tsx";
import { DocumentScreen } from "./screens/document.tsx";
import { DocumentsScreen } from "./screens/documents.tsx";
import { NodesScreen } from "./screens/nodes.tsx";
import { NotPairedScreen } from "./screens/not-paired.tsx";
import { PairScreen } from "./screens/pair.tsx";
import { ProjectsScreen } from "./screens/projects.tsx";
import { SessionsScreen } from "./screens/sessions.tsx";
import { TranscriptScreen } from "./screens/transcript.tsx";
import { auth, useAuth } from "./store/auth.ts";

const subscribeHash = (listener: () => void) => {
	window.addEventListener("hashchange", listener);
	return () => window.removeEventListener("hashchange", listener);
};
const getHash = () => window.location.hash;

export function App() {
	const hash = useSyncExternalStore(subscribeHash, getHash);
	const route = parseHash(hash);
	const state = useAuth();
	useEffect(() => {
		void auth.load(api.health);
	}, []);
	useEffect(() => {
		if (!hash) window.location.replace("#/projects");
	}, [hash]);
	if (route.screen === "pair") return <PairScreen code={route.code} key={route.code} />;
	if (state.unpaired) return <NotPairedScreen />;
	if (route.screen === "devices") return <DevicesScreen />;
	if (route.screen === "sessions") return <SessionsScreen projectId={route.projectId} />;
	if (route.screen === "nodes") return <NodesScreen />;
	if (route.screen === "transcript") {
		return <TranscriptScreen projectId={route.projectId} sessionId={route.sessionId} key={route.sessionId} />;
	}
	if (route.screen === "documents") return <DocumentsScreen projectId={route.projectId} />;
	if (route.screen === "document") {
		return (
			<DocumentScreen
				documentId={route.documentId}
				key={`${route.projectId}:${route.documentId}`}
				projectId={route.projectId}
			/>
		);
	}
	return <ProjectsScreen />;
}
