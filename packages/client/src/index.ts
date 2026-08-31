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
	listProjects(signal?: AbortSignal): Promise<Result<Protocol.ListProjectsResponse>>;
	listProjectSessions(
		projectId: Protocol.ProjectId,
		signal?: AbortSignal,
	): Promise<Result<Protocol.ListSessionsResponse>>;
	createProjectSession(
		projectId: Protocol.ProjectId,
		signal?: AbortSignal,
	): Promise<Result<Protocol.ReadableCatalogSession>>;
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
		listProjects: (signal) => request(routes.listProjects.path, { signal }),
		listProjectSessions: (projectId, signal) => request(routes.listProjectSessions.path, { signal }, { projectId }),
		createProjectSession: (projectId, signal) =>
			request(routes.createProjectSession.path, { method: routes.createProjectSession.method, signal }, { projectId }),
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

export type AttachItem =
	| { kind: "snapshot"; snapshot: Protocol.SessionSnapshot }
	| { kind: "event"; envelope: Protocol.EventEnvelope };

export class AttachError extends Error {
	readonly status: number;
	readonly error: Protocol.ErrorBody;

	constructor(status: number, error: Protocol.ErrorBody) {
		super(error.message ?? `Attach failed with HTTP ${status}`);
		this.name = "AttachError";
		this.status = status;
		this.error = error;
	}
}

export async function* attach(
	client: Client,
	sessionId: Protocol.SessionId,
	options: { signal?: AbortSignal; retryDelayMs?: number } = {},
): AsyncGenerator<AttachItem> {
	const signal = options.signal;
	const retryDelayMs = options.retryDelayMs ?? 1_000;
	let connected = false;
	let waitBeforeSnapshot = false;
	while (!signal?.aborted) {
		if (waitBeforeSnapshot && !(await waitForRetry(retryDelayMs, signal))) return;
		let snapshotResult: Result<Protocol.SessionSnapshot>;
		try {
			snapshotResult = await client.snapshot(sessionId, signal);
		} catch (error) {
			if (signal?.aborted) return;
			if (!connected) throw error;
			waitBeforeSnapshot = true;
			continue;
		}
		if (!snapshotResult.ok) throw new AttachError(snapshotResult.status, snapshotResult.error);
		connected = true;
		waitBeforeSnapshot = false;
		yield { kind: "snapshot", snapshot: snapshotResult.value };
		if (signal?.aborted) return;

		let subscription: Subscription;
		try {
			subscription = await client.subscribe(sessionId, snapshotResult.value.cursor, signal);
		} catch {
			if (signal?.aborted) return;
			waitBeforeSnapshot = true;
			continue;
		}
		if (subscription.kind === "resync") continue;
		if (subscription.kind === "error") throw new AttachError(subscription.status, subscription.error);
		try {
			for await (const envelope of subscription.envelopes) {
				if (signal?.aborted) return;
				yield { kind: "event", envelope };
			}
		} catch {
			if (signal?.aborted) return;
		}
		waitBeforeSnapshot = true;
	}
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve(true);
		}, delayMs);
		const abort = () => {
			clearTimeout(timeout);
			resolve(false);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function* eventEnvelopes(body: ReadableStream<Uint8Array>): AsyncGenerator<Protocol.EventEnvelope> {
	for await (const data of sseData(body)) yield JSON.parse(data) as Protocol.EventEnvelope;
}
