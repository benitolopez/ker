import { request } from "node:http";
import { Readable } from "node:stream";
import { DEFAULT_PORT } from "@ker-ai/protocol";

const daemonUrl = process.env.KER_TEST_DAEMON_URL;
if (!daemonUrl) throw new Error("KER_TEST_DAEMON_URL is required");

const destination = new URL(daemonUrl);

globalThis.fetch = async (input, init) => {
	const source = input instanceof Request ? input.url : input;
	const requested = new URL(source);
	const redirected = new URL(`${requested.pathname}${requested.search}`, destination);
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
	headers.set("host", `127.0.0.1:${DEFAULT_PORT}`);
	return new Promise<Response>((resolve, reject) => {
		const req = request(
			redirected,
			{
				method: init?.method ?? (input instanceof Request ? input.method : "GET"),
				headers: Object.fromEntries(headers),
				signal: init?.signal ?? undefined,
			},
			(res) => {
				const responseHeaders = new Headers();
				for (const [name, value] of Object.entries(res.headers)) {
					if (Array.isArray(value)) {
						for (const item of value) responseHeaders.append(name, item);
						continue;
					}
					if (value !== undefined) responseHeaders.set(name, value);
				}
				const status = res.statusCode ?? 500;
				const hasBody = ![101, 204, 205, 304].includes(status);
				resolve(
					new Response(hasBody ? Readable.toWeb(res) : null, {
						status,
						statusText: res.statusMessage,
						headers: responseHeaders,
					}),
				);
			},
		);
		req.once("error", reject);
		if (typeof init?.body === "string" || init?.body instanceof Uint8Array) {
			req.end(init.body);
			return;
		}
		if (init?.body !== undefined && init.body !== null) {
			req.destroy(new Error("Test fetch only supports string and byte request bodies"));
			return;
		}
		req.end();
	});
};
