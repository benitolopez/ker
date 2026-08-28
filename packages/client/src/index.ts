import * as Protocol from "@ker-ai/protocol";
import { routes } from "@ker-ai/protocol/routes";
import { sseData } from "./sse.ts";

export type Result<T> =
	| { ok: true; status: number; value: T }
	| { ok: false; status: number; error: Protocol.ErrorBody };

export type Subscription =
	| { kind: "stream"; envelopes: AsyncGenerator<Protocol.EventEnvelope> }
	| { kind: "resync" }
	| { kind: "error"; status: number; error: Protocol.ErrorBody };

export interface Client {
	health(signal?: AbortSignal): Promise<Result<Protocol.Health>>;
	openapi(signal?: AbortSignal): Promise<Result<Record<string, unknown>>>;
	createSession(cwd: string, signal?: AbortSignal): Promise<Result<Protocol.SessionDescriptor>>;
	listSessions(
		scope: { cwd: string } | { all: true },
		signal?: AbortSignal,
	): Promise<Result<Protocol.ListSessionsResponse>>;
	snapshot(id: Protocol.SessionId, signal?: AbortSignal): Promise<Result<Protocol.SessionSnapshot>>;
	prompt(id: Protocol.SessionId, text: string, signal?: AbortSignal): Promise<Result<Protocol.PromptAdmission>>;
	compact(
		id: Protocol.SessionId,
		instructions?: string,
		signal?: AbortSignal,
	): Promise<Result<Protocol.CompactionAdmission>>;
	cancel(
		id: Protocol.SessionId,
		turnId: Protocol.TurnId,
		signal?: AbortSignal,
	): Promise<Result<Protocol.TurnCancellationResult>>;
	subscribe(id: Protocol.SessionId, cursor: Protocol.Cursor, signal?: AbortSignal): Promise<Subscription>;
}

export function createClient(options: { baseUrl?: string } = {}): Client {
	const baseUrl = (options.baseUrl ?? `http://127.0.0.1:${Protocol.DEFAULT_PORT}`).replace(/\/$/, "");
	const request = async <T>(
		path: string,
		init?: RequestInit,
		params: Record<string, string> = {},
		query?: URLSearchParams,
	): Promise<Result<T>> => {
		const pathname = Object.entries(params).reduce(
			(current, [name, value]) => current.replace(`{${name}}`, encodeURIComponent(value)),
			path,
		);
		const response = await fetch(`${baseUrl}${pathname}${query ? `?${query}` : ""}`, init);
		const value = (await response.json()) as unknown;
		if (response.ok) return { ok: true, status: response.status, value: value as T };
		return { ok: false, status: response.status, error: value as Protocol.ErrorBody };
	};

	return {
		health: (signal) => request(routes.health.path, { signal }),
		openapi: (signal) => request(routes.openapi.path, { signal }),
		createSession: (cwd, signal) =>
			request(routes.createSession.path, {
				method: routes.createSession.method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd } satisfies Protocol.CreateSessionRequest),
				signal,
			}),
		listSessions: (scope, signal) =>
			request(
				routes.listSessions.path,
				{ signal },
				{},
				"all" in scope ? new URLSearchParams({ scope: "all" }) : new URLSearchParams({ cwd: scope.cwd }),
			),
		snapshot: (id, signal) => request(routes.snapshot.path, { signal }, { sessionId: id }),
		prompt: (id, text, signal) =>
			request(
				routes.prompt.path,
				{
					method: routes.prompt.method,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text } satisfies Protocol.PromptRequest),
					signal,
				},
				{ sessionId: id },
			),
		compact: (id, instructions, signal) =>
			request(
				routes.compact.path,
				{
					method: routes.compact.method,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(instructions === undefined ? {} : ({ instructions } satisfies Protocol.CompactRequest)),
					signal,
				},
				{ sessionId: id },
			),
		cancel: (id, turnId, signal) =>
			request(routes.cancel.path, { method: routes.cancel.method, signal }, { sessionId: id, turnId }),
		subscribe: async (id, cursor, signal) => {
			const pathname = routes.events.path.replace("{sessionId}", encodeURIComponent(id));
			const query = new URLSearchParams({ epoch: cursor.epoch, sequence: String(cursor.sequence) });
			const response = await fetch(`${baseUrl}${pathname}?${query}`, { signal });
			if (response.status === 410) return { kind: "resync" };
			if (!response.ok) {
				return {
					kind: "error",
					status: response.status,
					error: (await response.json()) as Protocol.ErrorBody,
				};
			}
			if (!response.body) {
				return {
					kind: "error",
					status: response.status,
					error: { code: "invalid_stream", message: "Event stream has no body" },
				};
			}
			return { kind: "stream", envelopes: eventEnvelopes(response.body) };
		},
	};
}

async function* eventEnvelopes(body: ReadableStream<Uint8Array>): AsyncGenerator<Protocol.EventEnvelope> {
	for await (const data of sseData(body)) yield JSON.parse(data) as Protocol.EventEnvelope;
}
