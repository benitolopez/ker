import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type * as Protocol from "@ker-ai/protocol";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
	ArchiveTooLargeError,
	archiveFileName,
	buildManifest,
	documentFileName,
	InvalidArchiveError,
	MAX_ARCHIVE_BYTES,
	MAX_DOCUMENT_BYTES,
	readArchive,
	slug,
	UnsupportedArchiveError,
	writeArchive,
} from "../src/archive.ts";

test("archive names stay readable and widen colliding document suffixes", () => {
	assert.equal(slug(" Àuth & Notes ", "document"), "auth-notes");
	assert.equal(slug("!!!", "document"), "document");
	assert.equal(slug("word ".repeat(50), "document").length, 59);
	assert.equal(archiveFileName("Ker Project", "2026-09-06T12:00:00.000Z"), "ker-project-2026-09-06.zip");
	const taken = new Set<string>();
	assert.equal(documentFileName("Notes", "12345678-0000-4000-8000-000000000001", taken), "documents/notes-12345678.md");
	assert.equal(
		documentFileName("Notes", "12345678-0000-4000-8000-000000000002", taken),
		"documents/notes-12345678000040008000000000000002.md",
	);
});

test("writer and reader preserve entry order, documents, and log bytes one byte at a time", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-archive-roundtrip-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const logPath = join(root, "session.jsonl");
	const log = Buffer.from([0, 1, 2, 10, 255]);
	await writeFile(logPath, log);
	const manifest = archiveManifest();
	const chunks: Uint8Array[] = [];
	await writeArchive(
		{
			manifest,
			documents: [{ file: manifest.documents[0].file, body: "# Body\n\nexact\n" }],
			logs: [{ file: manifest.sessions[0].file ?? "missing", path: logPath }],
		},
		async (chunk) => {
			chunks.push(Buffer.from(chunk));
		},
	);
	const bytes = Buffer.concat(chunks);
	const entries = unzipSync(bytes);
	assert.deepEqual(Object.keys(entries), ["manifest.json", manifest.documents[0].file, manifest.sessions[0].file]);

	const staging = join(root, "staging");
	const result = await readArchive(oneByteAtATime(bytes), staging);
	assert.deepEqual(result.manifest, manifest);
	assert.equal(await readFile(result.files.get(manifest.documents[0].file) ?? "", "utf8"), "# Body\n\nexact\n");
	assert.deepEqual(await readFile(result.files.get(manifest.sessions[0].file ?? "") ?? ""), log);
});

test("manifest building records a missing log instead of omitting the session", async () => {
	const input = await buildManifest({
		exportedAt: "2026-09-06T12:00:00.000Z",
		versions: { protocol: "24", store: 5, catalog: 3 },
		project: { id: "project-1", name: "ker", createdAt: "2026-01-01T00:00:00.000Z" },
		nodes: [],
		workspaces: [],
		sessions: [
			{
				id: "6d1e0c1a-1111-4111-8111-111111111111",
				projectKey: "a".repeat(64),
				workspaceId: "workspace-1",
				nodeId: "node-1",
				cwd: "/work/ker",
				title: "Session",
				status: "idle",
				error: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				path: "/definitely/missing/session.jsonl",
			},
		],
		documents: [],
	});
	assert.equal(input.manifest.sessions[0].file, null);
	assert.deepEqual(input.logs, []);
});

test("manifest building rejects logs whose combined size reaches the ZIP limit", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-archive-size-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const firstPath = join(root, "first.jsonl");
	const secondPath = join(root, "second.jsonl");
	await writeFile(firstPath, "");
	await writeFile(secondPath, "");
	await truncate(firstPath, MAX_ARCHIVE_BYTES / 2);
	await truncate(secondPath, MAX_ARCHIVE_BYTES / 2 - 1);

	await assert.rejects(
		buildManifest({
			exportedAt: "2026-09-06T12:00:00.000Z",
			versions: { protocol: "24", store: 5, catalog: 3 },
			project: { id: "project-1", name: "ker", createdAt: "2026-01-01T00:00:00.000Z" },
			nodes: [],
			workspaces: [],
			sessions: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					projectKey: "a".repeat(64),
					workspaceId: "workspace-1",
					nodeId: "node-1",
					cwd: "/work/ker",
					title: "First",
					status: "idle",
					error: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					path: firstPath,
				},
				{
					id: "22222222-2222-4222-8222-222222222222",
					projectKey: "a".repeat(64),
					workspaceId: "workspace-1",
					nodeId: "node-1",
					cwd: "/work/ker",
					title: "Second",
					status: "idle",
					error: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					path: secondPath,
				},
			],
			documents: [
				{
					id: "33333333-3333-4333-8333-333333333333",
					projectId: "project-1",
					title: "Boundary",
					body: "é",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		}),
		ArchiveTooLargeError,
	);
});

test("reader rejects invalid layout, declarations, sizes, versions, and checksums", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-archive-invalid-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const manifest = archiveManifest();
	const encoded = strToU8(`${JSON.stringify(manifest)}\n`);
	const cases: Array<{
		name: string;
		bytes: Uint8Array;
		error: typeof InvalidArchiveError | typeof UnsupportedArchiveError;
	}> = [
		{
			name: "manifest not first",
			bytes: zipSync({ "extra.txt": strToU8("x"), "manifest.json": encoded }),
			error: InvalidArchiveError,
		},
		{
			name: "oversized manifest",
			bytes: zipSync({ "manifest.json": new Uint8Array(MAX_DOCUMENT_BYTES + 1) }),
			error: InvalidArchiveError,
		},
		{
			name: "undeclared entry",
			bytes: zipSync({ "manifest.json": encoded, "documents/undeclared-12345678.md": strToU8("x") }),
			error: InvalidArchiveError,
		},
		{
			name: "traversal entry",
			bytes: zipSync({ "manifest.json": encoded, "../escape": strToU8("x") }),
			error: InvalidArchiveError,
		},
		{
			name: "session id traversal",
			bytes: zipSync({
				"manifest.json": strToU8(
					JSON.stringify({
						...manifest,
						sessions: [{ ...manifest.sessions[0], id: "../../outside/11111111-1111-4111-8111-111111111111" }],
					}),
				),
				[manifest.documents[0].file]: strToU8("body"),
				[manifest.sessions[0].file ?? "missing"]: strToU8("log"),
			}),
			error: InvalidArchiveError,
		},
		{
			name: "session file owned by another id",
			bytes: zipSync({
				"manifest.json": strToU8(
					JSON.stringify({
						...manifest,
						sessions: [{ ...manifest.sessions[0], id: "22222222-2222-4222-8222-222222222222" }],
					}),
				),
				[manifest.documents[0].file]: strToU8("body"),
				[manifest.sessions[0].file ?? "missing"]: strToU8("log"),
			}),
			error: InvalidArchiveError,
		},
		{
			name: "declared file absent",
			bytes: zipSync({ "manifest.json": encoded }),
			error: InvalidArchiveError,
		},
		{
			name: "unsupported format",
			bytes: zipSync({ "manifest.json": strToU8(JSON.stringify({ ...manifest, format: 2 })) }),
			error: UnsupportedArchiveError,
		},
		{
			name: "oversized document",
			bytes: zipSync({
				"manifest.json": encoded,
				[manifest.documents[0].file]: new Uint8Array(1024 * 1024 + 1),
				[manifest.sessions[0].file ?? "missing"]: strToU8("log"),
			}),
			error: InvalidArchiveError,
		},
	];
	for (const [index, item] of cases.entries()) {
		await assert.rejects(readArchive(asAsyncIterable(item.bytes), join(root, String(index))), item.error, item.name);
	}

	const valid = zipSync({
		"manifest.json": encoded,
		[manifest.documents[0].file]: strToU8("body"),
		[manifest.sessions[0].file ?? "missing"]: strToU8("log"),
	});
	const corrupted = Buffer.from(valid);
	const central = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	assert.notEqual(central, -1);
	corrupted[central + 16] ^= 0xff;
	await assert.rejects(readArchive(asAsyncIterable(corrupted), join(root, "crc")), InvalidArchiveError);
});

function archiveManifest(): Protocol.ArchiveManifest {
	const sessionId = "6d1e0c1a-1111-4111-8111-111111111111";
	return {
		format: 1,
		exportedAt: "2026-09-06T12:00:00.000Z",
		versions: { protocol: "24", store: 5, catalog: 3 },
		project: { id: "project-1", name: "ker", createdAt: "2026-01-01T00:00:00.000Z" },
		nodes: [{ id: "node-1", name: "laptop", createdAt: "2026-01-01T00:00:00.000Z" }],
		workspaces: [
			{
				id: "workspace-1",
				nodeId: "node-1",
				rootPath: "/work/ker",
				gitRemote: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
		sessions: [
			{
				id: sessionId,
				projectKey: "a".repeat(64),
				workspaceId: "workspace-1",
				nodeId: "node-1",
				cwd: "/work/ker",
				title: "Session",
				status: "idle",
				error: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				file: `sessions/${sessionId}/session.jsonl`,
			},
		],
		documents: [
			{
				id: "3f9a1c2e-2222-4222-8222-222222222222",
				title: "Roadmap",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				file: "documents/roadmap-3f9a1c2e.md",
			},
		],
	};
}

async function* oneByteAtATime(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	for (const byte of bytes) yield Uint8Array.of(byte);
}

async function* asAsyncIterable(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}
