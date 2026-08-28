import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createOpenApiDocument, createOpenApiJson } from "../src/openapi.ts";

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
	];

	for (const [schema, name] of references) {
		assert.deepEqual(schema, { $ref: `#/components/schemas/${name}` });
	}
});

test("the committed OpenAPI document matches the route table", async () => {
	const committed = await readFile(new URL("../openapi.json", import.meta.url), "utf8");
	assert.equal(committed, createOpenApiJson(), "OpenAPI document is stale; run `npm run generate -w @ker-ai/protocol`");
});
