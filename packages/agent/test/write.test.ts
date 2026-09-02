import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type * as Engine from "@ker-ai/engine";
import { createDefinition } from "../src/index.ts";

function writeTool() {
	const found = createDefinition(process.cwd()).tools.find((t) => t.name === "write");
	if (!found) throw new Error("write tool not registered");
	return found;
}
const write = writeTool();

async function tempDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ker-write-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("creates a new file and reports the byte count", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "hello.txt");
	const result = requireToolResult(await write.execute({ path, content: "hi" }));
	assert.equal(result.output, `Created ${path} (2 bytes)`);
	assert.deepEqual(result.details, {
		kind: "diff",
		path,
		patch: `--- ${path}\n+++ ${path}\n@@ -0,0 +1,1 @@\n+hi\n\\ No newline at end of file\n`,
	});
	assert.equal(await readFile(path, "utf8"), "hi");
});

test("overwrites an existing file and says so", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "hello.txt");
	await writeFile(path, "old", "utf8");
	const result = requireToolResult(await write.execute({ path, content: "new content" }));
	assert.equal(result.output, `Wrote ${path} (11 bytes)`);
	assert.equal(result.details?.kind, "diff");
	if (result.details?.kind === "diff") {
		assert.match(result.details.patch, /-old\n\\ No newline at end of file\n\+new content/);
	}
	assert.equal(await readFile(path, "utf8"), "new content");
});

test("creates missing parent directories", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "a", "b", "c", "file.txt");
	assert.equal(requireToolResult(await write.execute({ path, content: "deep" })).output, `Created ${path} (4 bytes)`);
	assert.equal(await readFile(path, "utf8"), "deep");
});

test("empty content writes an empty file", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "empty.txt");
	assert.equal(requireToolResult(await write.execute({ path, content: "" })).output, `Created ${path} (0 bytes)`);
	assert.equal(existsSync(path), true);
	assert.equal(await readFile(path, "utf8"), "");
});

test("byte count is true UTF-8, not JS string length", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "emoji.txt");
	// "a😀" is 3 UTF-16 code units but 5 UTF-8 bytes (1 + 4).
	assert.equal(requireToolResult(await write.execute({ path, content: "a😀" })).output, `Created ${path} (5 bytes)`);
});

test("writes verbatim without touching a trailing newline", async (t) => {
	const dir = await tempDir(t);
	const withNl = join(dir, "with.txt");
	await write.execute({ path: withNl, content: "hi\n" });
	assert.equal(await readFile(withNl, "utf8"), "hi\n");
	const withoutNl = join(dir, "without.txt");
	await write.execute({ path: withoutNl, content: "hi" });
	assert.equal(await readFile(withoutNl, "utf8"), "hi");
});

test("rejects a non-string or empty path", async () => {
	await assert.rejects(write.execute({ path: "", content: "x" }), /'path' must be a non-empty string/);
	await assert.rejects(write.execute({ path: 42, content: "x" }), /'path' must be a non-empty string/);
});

test("rejects non-string content", async () => {
	await assert.rejects(write.execute({ path: "placeholder.txt", content: 42 }), /'content' must be a string/);
});

test("drops details when a new-file patch exceeds the cap", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "large.txt");
	const content = "new line\n".repeat(40_000);

	assert.equal(await write.execute({ path, content }), `Created ${path} (${Buffer.byteLength(content)} bytes)`);
});

test("skips reading an existing source above the guard", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "large-source.txt");
	await writeFile(path, "old", "utf8");
	await truncate(path, 4 * 1024 * 1024 + 1);

	assert.equal(await write.execute({ path, content: "replacement" }), `Wrote ${path} (11 bytes)`);
	assert.equal(await readFile(path, "utf8"), "replacement");
});

test("does not start a write when the turn is already aborted", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "cancelled.txt");
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		write.execute({ path, content: "should not be written" }, controller.signal),
		(error: unknown) => error instanceof DOMException && error.name === "AbortError",
	);
	assert.equal(existsSync(path), false);
});

function requireToolResult(result: string | Engine.ToolResult): Engine.ToolResult {
	if (typeof result === "string") throw new Error("Expected structured tool result");
	return result;
}
