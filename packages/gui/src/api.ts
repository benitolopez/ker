import { attach, type Client, createClient } from "@ker-ai/client";
import { auth } from "./store/auth.ts";

export const api = observeUnauthorized(createClient({ baseUrl: "" }));
export { attach };

export function observeUnauthorized(client: Client): Client {
	const methods = Object.fromEntries(
		Object.entries(client).map(([name, method]) => [
			name,
			(...args: unknown[]) => {
				const result: unknown = Reflect.apply(method, client, args);
				if (!(result instanceof Promise)) return result;
				return result.then((value: unknown) => {
					if (
						typeof value === "object" &&
						value !== null &&
						"status" in value &&
						value.status === 401 &&
						(("ok" in value && value.ok === false) || ("kind" in value && value.kind === "error"))
					)
						auth.setUnpaired();
					return value;
				});
			},
		]),
	);
	return Object.assign({}, client, methods);
}
