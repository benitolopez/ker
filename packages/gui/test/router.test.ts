import { assert, test } from "vitest";
import { formatRoute, parseHash } from "../src/router.ts";

test("parses every GUI hash route and falls back to projects", () => {
	assert.deepEqual(parseHash(""), { screen: "projects" });
	assert.deepEqual(parseHash("#/projects"), { screen: "projects" });
	assert.deepEqual(parseHash("#/projects/project%201/sessions"), {
		screen: "sessions",
		projectId: "project 1",
	});
	assert.deepEqual(parseHash("#/projects/project%201/sessions/session%2F1"), {
		screen: "transcript",
		projectId: "project 1",
		sessionId: "session/1",
	});
	assert.deepEqual(parseHash("#/projects/project%201/documents"), {
		screen: "documents",
		projectId: "project 1",
	});
	assert.deepEqual(parseHash("#/projects/project%201/documents/new"), {
		screen: "document",
		projectId: "project 1",
		documentId: "new",
	});
	assert.deepEqual(parseHash("#/projects/project%201/documents/document%2F1"), {
		screen: "document",
		projectId: "project 1",
		documentId: "document/1",
	});
	assert.deepEqual(parseHash("#/unknown"), { screen: "projects" });
	assert.deepEqual(parseHash("#/projects/%E0%A4%A/sessions"), { screen: "projects" });
});

test("formats routes with encoded opaque identifiers", () => {
	assert.equal(formatRoute({ screen: "projects" }), "#/projects");
	assert.equal(formatRoute({ screen: "sessions", projectId: "project/one" }), "#/projects/project%2Fone/sessions");
	assert.equal(
		formatRoute({ screen: "transcript", projectId: "project/one", sessionId: "session two" }),
		"#/projects/project%2Fone/sessions/session%20two",
	);
	assert.equal(formatRoute({ screen: "documents", projectId: "project/one" }), "#/projects/project%2Fone/documents");
	assert.equal(
		formatRoute({ screen: "document", projectId: "project/one", documentId: "document two" }),
		"#/projects/project%2Fone/documents/document%20two",
	);
});

test("device and pairing routes round-trip opaque codes", () => {
	assert.deepEqual(parseHash("#/devices"), { screen: "devices" });
	assert.equal(formatRoute({ screen: "devices" }), "#/devices");
	assert.deepEqual(parseHash(formatRoute({ screen: "pair", code: "opaque/code?#" })), {
		screen: "pair",
		code: "opaque/code?#",
	});
	assert.deepEqual(parseHash("#/pair/%ZZ"), { screen: "projects" });
	assert.deepEqual(parseHash("#/pair/"), { screen: "projects" });
});
