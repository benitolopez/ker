import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type * as Engine from "@ker-ai/engine";
import type * as Protocol from "@ker-ai/protocol";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { DaemonOptions } from "../src/index.ts";
import { startTestRuntime } from "./runtime.ts";

const runtimeHeaders = new Map<string, Record<string, string>>();

test("a project archive round-trips through two daemons and re-import skips existing data", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-export-import-"));
	const source = await startServer(t, join(root, "source"));
	const targetRoot = join(root, "target");
	const target = await startServer(t, targetRoot);

	const created = await json<Protocol.SessionDescriptor>(
		await localRequest(source.url, "/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: process.cwd() }),
		}),
		201,
	);
	const second = await json<Protocol.SessionDescriptor>(
		await localRequest(source.url, "/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: process.cwd() }),
		}),
		201,
	);
	const projects = await json<Protocol.ListProjectsResponse>(await localRequest(source.url, "/projects"), 200);
	const project = projects.projects[0];
	assert(project);
	const document = await json<Protocol.Document>(
		await localRequest(source.url, `/projects/${project.id}/documents`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Notes", body: "# Exact body\n" }),
		}),
		201,
	);
	const secondDocument = await json<Protocol.Document>(
		await localRequest(source.url, `/projects/${project.id}/documents`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Roadmap", body: "Second body\n" }),
		}),
		201,
	);

	const exported = await localRequest(source.url, `/projects/${project.id}/export`);
	assert.equal(exported.status, 200);
	assert.equal(exported.headers["content-type"], "application/zip");
	assert.match(exported.headers["content-disposition"] ?? "", /^attachment; filename=".+\.zip"$/);
	const entries = unzipSync(exported.body);
	assert.equal(Object.keys(entries)[0], "manifest.json");
	const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as Protocol.ArchiveManifest;
	assert.equal(manifest.project.id, project.id);
	assert.equal(manifest.documents.length, 2);
	assert.equal(manifest.sessions.length, 2);
	for (const expected of [document, secondDocument]) {
		const item = manifest.documents.find((candidate) => candidate.id === expected.id);
		assert(item);
		assert.equal(strFromU8(entries[item.file]), expected.body);
	}

	const imported = await json<Protocol.ImportResult>(
		await localRequest(target.url, "/projects/import", {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: exported.body,
		}),
		201,
	);
	assert.equal(imported.project.id, project.id);
	assert.equal(imported.created, true);
	assert.deepEqual(imported.documents, { imported: 2, skipped: 0 });
	assert.deepEqual(imported.sessions, { imported: 2, skipped: 0, unreadable: 0, missing: 0 });
	for (const expected of [document, secondDocument]) {
		assert.deepEqual(
			await json<Protocol.Document>(await localRequest(target.url, `/documents/${expected.id}`), 200),
			expected,
		);
	}
	const importedSessions = await json<Protocol.ListSessionsResponse>(
		await localRequest(target.url, `/projects/${project.id}/sessions`),
		200,
	);
	assert.deepEqual(new Set(importedSessions.sessions.map((session) => session.id)), new Set([created.id, second.id]));
	for (const session of manifest.sessions) {
		assert(session.file);
		assert.deepEqual(
			await readFile(join(targetRoot, "sessions", session.projectKey, session.id, "session.jsonl")),
			Buffer.from(entries[session.file]),
		);
	}
	const workspaces = await json<Protocol.ListWorkspacesResponse>(
		await localRequest(target.url, `/projects/${project.id}/workspaces`),
		200,
	);
	assert.equal(workspaces.workspaces[0]?.exists, true);

	const repeated = await json<Protocol.ImportResult>(
		await localRequest(target.url, "/projects/import", {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: exported.body,
		}),
		201,
	);
	assert.equal(repeated.created, false);
	assert.deepEqual(repeated.documents, { imported: 0, skipped: 2 });
	assert.deepEqual(repeated.sessions, { imported: 0, skipped: 2, unreadable: 0, missing: 0 });

	await target.stop();
	const restarted = await startServer(t, targetRoot);
	const afterRestart = await json<Protocol.ListSessionsResponse>(
		await localRequest(restarted.url, `/projects/${project.id}/sessions`),
		200,
	);
	assert.deepEqual(new Set(afterRestart.sessions.map((session) => session.id)), new Set([created.id, second.id]));
	assert.equal((await localRequest(restarted.url, `/projects/${project.id}/sessions`, { method: "POST" })).status, 201);

	const missingManifest = structuredClone(manifest);
	missingManifest.sessions = missingManifest.sessions.map((session) => ({ ...session, file: null }));
	const missingEntries: Record<string, Uint8Array> = {
		"manifest.json": strToU8(`${JSON.stringify(missingManifest)}\n`),
	};
	for (const item of missingManifest.documents) missingEntries[item.file] = entries[item.file];
	const missingTarget = await startServer(t, join(root, "missing-target"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const missing = await json<Protocol.ImportResult>(
		await localRequest(missingTarget.url, "/projects/import", {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: zipSync(missingEntries),
		}),
		201,
	);
	assert.deepEqual(missing.sessions, { imported: 0, skipped: 0, unreadable: 0, missing: 2 });
	assert.deepEqual(
		await json<Protocol.ListSessionsResponse>(
			await localRequest(missingTarget.url, `/projects/${project.id}/sessions`),
			200,
		),
		{ sessions: [] },
	);
});

test("import turns a busy exported session into history without running queued work", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-export-busy-"));
	const started = Promise.withResolvers<void>();
	const source = await startServer(t, join(root, "source"), { harnessFactory: blockingFactory(started.resolve) });
	const targetCalls = { sends: 0, compactions: 0 };
	const target = await startServer(t, join(root, "target"), {
		harnessFactory: (initial) => {
			const state = structuredClone(initial);
			return {
				snapshot: () => structuredClone(state),
				async *compact() {
					targetCalls.compactions++;
					yield* [];
					return { kind: "skipped", reason: "nothing_to_compact" };
				},
				async *send(input) {
					targetCalls.sends++;
					state.messages.push({ role: "user", content: input.text });
					yield delivered(input);
					yield { actor: "process", sessionId: input.sessionId, turnId: input.turnId, type: "end" };
				},
			};
		},
		compaction: { enabled: true, reserveTokens: 271_999, keepRecentTokens: 1, prune: false },
	});
	t.after(() => rm(root, { recursive: true, force: true }));
	const created = await json<Protocol.SessionDescriptor>(
		await localRequest(source.url, "/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: process.cwd() }),
		}),
		201,
	);
	const running = await json<Protocol.PromptAdmission>(
		await localRequest(source.url, `/sessions/${created.id}/prompts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "keep working" }),
		}),
		202,
	);
	await started.promise;
	const waiting = await json<Protocol.PromptAdmission>(
		await localRequest(source.url, `/sessions/${created.id}/prompts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "run after the first prompt" }),
		}),
		202,
	);
	assert.equal(waiting.status, "waiting");
	const projects = await json<Protocol.ListProjectsResponse>(await localRequest(source.url, "/projects"), 200);
	const archive = await localRequest(source.url, `/projects/${projects.projects[0]?.id}/export`);
	const imported = await json<Protocol.ImportResult>(
		await localRequest(target.url, "/projects/import", {
			method: "POST",
			headers: { "content-type": "application/zip" },
			body: archive.body,
		}),
		201,
	);
	assert.equal(imported.sessions.imported, 1);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const snapshot = await json<Protocol.SessionSnapshot>(await localRequest(target.url, `/sessions/${created.id}`), 200);
	assert.equal(snapshot.queue.running, undefined);
	assert.equal(snapshot.queue.waiting.length, 0);
	assert.equal(snapshot.turns.find((turn) => turn.id === running.turnId)?.status, "aborted");
	assert.equal(snapshot.turns.find((turn) => turn.id === waiting.turnId)?.status, "expired");
	assert.equal(
		snapshot.entries.some(
			(entry) =>
				entry.role === "developer" &&
				entry.content === "The turn was active when this session was exported. Tools may have partially executed.",
		),
		true,
	);
	assert.deepEqual(targetCalls, { sends: 0, compactions: 0 });
	const exportedAgain = await localRequest(target.url, `/projects/${imported.project.id}/export`);
	const manifest = JSON.parse(strFromU8(unzipSync(exportedAgain.body)["manifest.json"])) as Protocol.ArchiveManifest;
	assert.equal(manifest.sessions[0]?.status, "idle");
	assert.match(
		await readFile(
			join(root, "target", "sessions", manifest.sessions[0]?.projectKey ?? "", created.id, "session.jsonl"),
			"utf8",
		),
		/"type":"aborted"/,
	);
});

test("export keeps an unreadable session log and flags it in the manifest", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-export-unreadable-"));
	const sourceRoot = join(root, "source");
	const source = await startServer(t, sourceRoot);
	const created = await json<Protocol.SessionDescriptor>(
		await localRequest(source.url, "/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: process.cwd() }),
		}),
		201,
	);
	const projects = await json<Protocol.ListProjectsResponse>(await localRequest(source.url, "/projects"), 200);
	const firstArchive = await localRequest(source.url, `/projects/${projects.projects[0]?.id}/export`);
	const firstManifest = JSON.parse(
		strFromU8(unzipSync(firstArchive.body)["manifest.json"]),
	) as Protocol.ArchiveManifest;
	const firstSession = firstManifest.sessions[0];
	assert(firstSession?.file);
	const logPath = join(sourceRoot, "sessions", firstSession.projectKey, created.id, "session.jsonl");
	await source.stop();
	await appendFile(logPath, "{not-json}\n");
	const restarted = await startServer(t, sourceRoot);
	t.after(() => rm(root, { recursive: true, force: true }));
	const exported = await localRequest(restarted.url, `/projects/${projects.projects[0]?.id}/export`);
	const entries = unzipSync(exported.body);
	const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as Protocol.ArchiveManifest;
	assert.equal(manifest.sessions[0]?.status, "unreadable");
	assert.deepEqual(Buffer.from(entries[manifest.sessions[0]?.file ?? ""]), await readFile(logPath));
});

test("import validates media type and refuses workspace conflicts without creating the project", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-export-conflict-"));
	const source = await startServer(t, join(root, "source"));
	const target = await startServer(t, join(root, "target"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await localRequest(source.url, "/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	await localRequest(target.url, "/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	const sourceProjects = await json<Protocol.ListProjectsResponse>(await localRequest(source.url, "/projects"), 200);
	const archive = await localRequest(source.url, `/projects/${sourceProjects.projects[0]?.id}/export`);
	assert.equal(
		(await localRequest(target.url, "/projects/import", { method: "POST", body: archive.body })).status,
		415,
	);
	const before = await json<Protocol.ListProjectsResponse>(await localRequest(target.url, "/projects"), 200);
	const conflict = await localRequest(target.url, "/projects/import", {
		method: "POST",
		headers: { "content-type": "application/zip" },
		body: archive.body,
	});
	assert.equal(conflict.status, 409);
	assert.equal((await json<Protocol.ErrorBody>(conflict, 409)).code, "workspace_conflict");
	assert.deepEqual(await json<Protocol.ListProjectsResponse>(await localRequest(target.url, "/projects"), 200), before);
});

test("import reports staging filesystem failures as server errors", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-export-storage-error-"));
	const source = await startServer(t, join(root, "source"));
	const target = await startServer(t, join(root, "target"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await localRequest(source.url, "/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	const projects = await json<Protocol.ListProjectsResponse>(await localRequest(source.url, "/projects"), 200);
	const archive = await localRequest(source.url, `/projects/${projects.projects[0]?.id}/export`);
	const probe = await open(join(root, "probe"), "w");
	const fileHandlePrototype = Object.getPrototypeOf(probe) as { write: () => Promise<never> };
	await probe.close();
	const diskFull = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
	t.mock.method(fileHandlePrototype, "write", async () => {
		throw diskFull;
	});

	const response = await localRequest(target.url, "/projects/import", {
		method: "POST",
		headers: { "content-type": "application/zip" },
		body: archive.body,
	});
	assert.equal(response.status, 500);
	assert.equal((await json<Protocol.ErrorBody>(response, 500)).code, "internal");
});

async function startServer(
	t: TestContext,
	root: string,
	options: Pick<DaemonOptions, "harnessFactory" | "compaction"> = {},
): Promise<{ url: string; stop: () => Promise<void> }> {
	const running = await startTestRuntime({
		sessionDir: join(root, "sessions"),
		catalogPath: join(root, "catalog.db"),
		nodePath: join(root, "node.json"),
		harnessFactory: options.harnessFactory ?? immediateFactory(),
		definition: () => ({
			systemPrompt: "System prompt",
			tools: [],
			compaction: {
				systemPrompt: "Summary system prompt",
				initialInstructions: "Initial instructions",
				updateInstructions: "Update instructions",
			},
		}),
		recoveryWindowMinutes: Number.MAX_SAFE_INTEGER,
		compaction: options.compaction ?? { enabled: false, reserveTokens: 100, keepRecentTokens: 20, prune: false },
	});
	runtimeHeaders.set(running.url, running.headers);
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await running.stop();
	};
	t.after(stop);
	return { url: running.url, stop };
}

function immediateFactory(): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			async *compact() {
				yield* [];
				return { kind: "skipped", reason: "nothing_to_compact" };
			},
			async *send(input) {
				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				const messageId = randomUUID();
				const text = `answer:${input.text}`;
				yield {
					actor: "agent",
					modelRole: "assistant",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "message_delta",
					messageId,
					offset: 0,
					text,
				};
				state.messages.push({ role: "assistant", content: text, toolCalls: [], reasoning: [] });
				yield {
					actor: "agent",
					modelRole: "assistant",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "assistant_message_completed",
					messageId,
					reason: "completed",
				};
				yield { actor: "process", sessionId: input.sessionId, turnId: input.turnId, type: "end" };
			},
		};
	};
}

function blockingFactory(started: () => void): NonNullable<DaemonOptions["harnessFactory"]> {
	return (initial) => {
		const state = structuredClone(initial);
		return {
			snapshot: () => structuredClone(state),
			async *compact() {
				yield* [];
				return { kind: "skipped", reason: "nothing_to_compact" };
			},
			async *send(input, signal) {
				state.messages.push({ role: "user", content: input.text });
				yield delivered(input);
				yield {
					actor: "process",
					sessionId: input.sessionId,
					turnId: input.turnId,
					type: "usage",
					provider: "openai",
					model: "gpt-5.4-mini",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
				};
				started();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve();
						return;
					}
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			},
		};
	};
}

function delivered(input: Engine.UserMessage): Protocol.MessageDeliveredEvent {
	return {
		actor: "human",
		modelRole: "user",
		sessionId: input.sessionId,
		turnId: input.turnId,
		type: "message_delivered",
		messageId: input.messageId,
		text: input.text,
	};
}

interface ResponseData {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}

function localRequest(
	baseUrl: string,
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {},
): Promise<ResponseData> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${baseUrl}${path}`,
			{
				method: init.method,
				headers: { ...runtimeHeaders.get(new URL(baseUrl).origin), ...init.headers },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: Object.fromEntries(
							Object.entries(response.headers).flatMap(([name, value]) =>
								value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
							),
						),
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(init.body);
	});
}

async function json<T>(response: ResponseData, status: number): Promise<T> {
	assert.equal(response.status, status);
	return JSON.parse(response.body.toString("utf8")) as T;
}
