import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { ArchiveManifest } from "../src/index.ts";
import { createOpenApiDocument, createOpenApiJson } from "../src/openapi.ts";
import { routes } from "../src/routes.ts";

test("the archive and workspace routes describe binary and JSON traffic", () => {
	assert.equal(routes.exportProject.kind, "download");
	assert.equal(routes.importProject.upload, "application/zip");
	assert.equal(routes.listWorkspaces.method, "GET");
	assert.equal(routes.createWorkspace.method, "POST");

	const document = createOpenApiDocument() as {
		paths: Record<
			string,
			Record<
				string,
				{
					requestBody?: { content: Record<string, unknown> };
					responses: Record<string, { content: Record<string, unknown> }>;
				}
			>
		>;
	};
	assert(document.paths["/projects/import"]?.post?.requestBody?.content["application/zip"]);
	assert(document.paths["/projects/{projectId}/export"]?.get?.responses["200"]?.content["application/zip"]);
});

test("the archive manifest schema accepts the format contract", () => {
	const manifest = {
		format: 1,
		exportedAt: "2026-09-06T10:00:00.000Z",
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
				id: "6d1e0c1a-1111-4111-8111-111111111111",
				projectKey: "a".repeat(64),
				workspaceId: "workspace-1",
				nodeId: "node-1",
				cwd: "/work/ker",
				title: null,
				status: "idle",
				error: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				file: "sessions/6d1e0c1a-1111-4111-8111-111111111111/session.jsonl",
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
	assert(Value.Check(ArchiveManifest, manifest));
	assert(Value.Check(ArchiveManifest, { ...manifest, format: 2 }));
	assert(!Value.Check(ArchiveManifest, { ...manifest, unexpected: true }));
	assert(!Value.Check(ArchiveManifest, { ...manifest, sessions: [{ ...manifest.sessions[0], projectKey: "bad" }] }));
	assert(
		!Value.Check(ArchiveManifest, { ...manifest, sessions: [{ ...manifest.sessions[0], file: "../session.jsonl" }] }),
	);
	assert(!Value.Check(ArchiveManifest, { ...manifest, documents: [{ ...manifest.documents[0], file: "/notes.md" }] }));
});

test("optional component schemas are emitted as references", () => {
	const document = createOpenApiDocument() as {
		components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
	};
	const schemas = document.components.schemas;
	const references: Array<[unknown, string]> = [
		[schemas.SessionSnapshot.properties?.model, "Model"],
		[schemas.SessionSnapshot.properties?.identity, "Identity"],
		[schemas.SessionSnapshot.properties?.compactionFailure, "CompactionFailure"],
		[schemas.SessionSnapshot.properties?.active, "ActiveAssistantMessage"],
		[schemas.QueueSnapshot.properties?.running, "QueueItem"],
		[schemas.ErrorEvent.properties?.code, "ErrorCode"],
		[schemas.ErrorEvent.properties?.expected, "Identity"],
		[schemas.ErrorEvent.properties?.actual, "Identity"],
		[schemas.ToolResultEvent.properties?.details, "ToolDetails"],
	];

	for (const [schema, name] of references) {
		assert.deepEqual(schema, { $ref: `#/components/schemas/${name}` });
	}
});

test("the committed OpenAPI document matches the route table", async () => {
	const committed = await readFile(new URL("../openapi.json", import.meta.url), "utf8");
	assert.equal(committed, createOpenApiJson(), "OpenAPI document is stale; run `npm run generate -w @ker-ai/protocol`");
});
