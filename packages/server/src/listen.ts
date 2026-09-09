import { DEFAULT_PORT } from "@ker-ai/protocol";
import { parsePublicUrl } from "./access.ts";

export interface ListenOptions {
	host: string;
	port: number;
	publicUrl?: URL;
}

export class ListenOptionsError extends Error {}

export function resolveListenOptions(
	flags: { host?: string; port?: string; publicUrl?: string },
	env: NodeJS.ProcessEnv = process.env,
): ListenOptions {
	const host = flags.host ?? env.KER_HOST ?? "127.0.0.1";
	const rawPort = flags.port ?? env.KER_PORT ?? String(DEFAULT_PORT);
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ListenOptionsError(`Invalid port ${rawPort}`);
	if (!host.trim()) throw new ListenOptionsError("Host must not be empty");
	const rawPublicUrl = flags.publicUrl ?? env.KER_PUBLIC_URL;
	const publicUrl = requirePublicUrl(rawPublicUrl);
	if (!publicUrl && !["localhost", "127.0.0.1", "::1"].includes(host)) {
		throw new ListenOptionsError(
			`Binding ${host} needs --public-url; ker never serves a public address without client authentication`,
		);
	}
	return { host, port, publicUrl };
}

function requirePublicUrl(value: string | undefined): URL | undefined {
	if (value === undefined) return undefined;
	try {
		return parsePublicUrl(value);
	} catch (error) {
		throw new ListenOptionsError(error instanceof Error ? error.message : String(error));
	}
}
