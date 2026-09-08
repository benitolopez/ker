import type { IncomingMessage } from "node:http";
import { DEFAULT_PORT } from "@ker-ai/protocol";

export function isLocalRequest(req: IncomingMessage): boolean {
	const host = req.headers.host ?? "";
	const match = host.match(/^(localhost|127\.0\.0\.1):(\d+)$/);
	const port = Number(match?.[2]);
	if (!match || (port !== DEFAULT_PORT && port !== req.socket.localPort)) return false;
	const origin = req.headers.origin;
	return origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
