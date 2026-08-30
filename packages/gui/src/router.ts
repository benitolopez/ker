export type Route =
	| { screen: "projects" }
	| { screen: "sessions"; projectId: string }
	| { screen: "transcript"; projectId: string; sessionId: string };

export function parseHash(hash: string): Route {
	const path = hash.replace(/^#\/?/, "").replace(/\/$/, "");
	if (!path || path === "projects") return { screen: "projects" };
	try {
		const segments = path.split("/").map(decodeURIComponent);
		if (segments.length === 3 && segments[0] === "projects" && segments[2] === "sessions") {
			return { screen: "sessions", projectId: segments[1] };
		}
		if (segments.length === 4 && segments[0] === "projects" && segments[2] === "sessions") {
			return { screen: "transcript", projectId: segments[1], sessionId: segments[3] };
		}
	} catch {}
	return { screen: "projects" };
}

export function formatRoute(route: Route): string {
	if (route.screen === "projects") return "#/projects";
	const project = encodeURIComponent(route.projectId);
	if (route.screen === "sessions") return `#/projects/${project}/sessions`;
	return `#/projects/${project}/sessions/${encodeURIComponent(route.sessionId)}`;
}
