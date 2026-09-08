export type Route =
	| { screen: "projects" }
	| { screen: "nodes" }
	| { screen: "sessions"; projectId: string }
	| { screen: "transcript"; projectId: string; sessionId: string }
	| { screen: "documents"; projectId: string }
	| { screen: "document"; projectId: string; documentId: string };

export function parseHash(hash: string): Route {
	const path = hash.replace(/^#\/?/, "").replace(/\/$/, "");
	if (!path || path === "projects") return { screen: "projects" };
	if (path === "nodes") return { screen: "nodes" };
	try {
		const segments = path.split("/").map(decodeURIComponent);
		if (segments.length === 3 && segments[0] === "projects" && segments[2] === "sessions") {
			return { screen: "sessions", projectId: segments[1] };
		}
		if (segments.length === 4 && segments[0] === "projects" && segments[2] === "sessions") {
			return { screen: "transcript", projectId: segments[1], sessionId: segments[3] };
		}
		if (segments.length === 3 && segments[0] === "projects" && segments[2] === "documents") {
			return { screen: "documents", projectId: segments[1] };
		}
		if (segments.length === 4 && segments[0] === "projects" && segments[2] === "documents") {
			return { screen: "document", projectId: segments[1], documentId: segments[3] };
		}
	} catch {}
	return { screen: "projects" };
}

export function formatRoute(route: Route): string {
	if (route.screen === "projects") return "#/projects";
	if (route.screen === "nodes") return "#/nodes";
	const project = encodeURIComponent(route.projectId);
	if (route.screen === "sessions") return `#/projects/${project}/sessions`;
	if (route.screen === "transcript") return `#/projects/${project}/sessions/${encodeURIComponent(route.sessionId)}`;
	if (route.screen === "documents") return `#/projects/${project}/documents`;
	return `#/projects/${project}/documents/${encodeURIComponent(route.documentId)}`;
}
