import type { IncomingMessage } from "node:http";
import { DEFAULT_PORT } from "@ker-ai/protocol";

export type Access = { mode: "local" } | { mode: "device"; publicUrl: URL };

export function acceptsRequest(access: Access, req: IncomingMessage): boolean {
	if (access.mode === "local") return isLocalRequest(req);
	if (req.headers.host !== access.publicUrl.host) return false;
	return req.headers.origin === undefined || req.headers.origin === access.publicUrl.origin;
}

export function acceptsUpgrade(access: Access, req: IncomingMessage): boolean {
	return acceptsRequest(access, req);
}

export function requiresOrigin(method: string | undefined, carrier: "cookie" | "bearer"): boolean {
	return carrier === "cookie" && method !== "GET" && method !== "HEAD";
}

export function parsePublicUrl(value: string): URL {
	const message = "--public-url must be an https origin such as https://ker.example.com";
	const url = URL.canParse(value) ? new URL(value) : undefined;
	if (
		!url ||
		url.protocol !== "https:" ||
		url.pathname !== "/" ||
		/[?#]/.test(url.href) ||
		url.username ||
		url.password
	) {
		throw new Error(message);
	}
	return url;
}

function isLocalRequest(req: IncomingMessage): boolean {
	const host = req.headers.host ?? "";
	const match = host.match(/^(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/);
	const port = Number(match?.[2]);
	if (!match || (port !== DEFAULT_PORT && port !== req.socket.localPort)) return false;
	const origin = req.headers.origin;
	return origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}
