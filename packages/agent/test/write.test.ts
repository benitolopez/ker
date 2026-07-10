import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { tools } from "../src/index.ts";

function writeTool() {
	const found = tools.find((t) => t.name === "write");
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
	assert.equal(await write.execute({ path, content: "hi" }), `Created ${path} (2 bytes)`);
	assert.equal(await readFile(path, "utf8"), "hi");
});

test("overwrites an existing file and says so", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "hello.txt");
	await writeFile(path, "old", "utf8");
	assert.equal(await write.execute({ path, content: "new content" }), `Wrote ${path} (11 bytes)`);
	assert.equal(await readFile(path, "utf8"), "new content");
});

test("creates missing parent directories", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "a", "b", "c", "file.txt");
	assert.equal(await write.execute({ path, content: "deep" }), `Created ${path} (4 bytes)`);
	assert.equal(await readFile(path, "utf8"), "deep");
});

test("empty content writes an empty file", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "empty.txt");
	assert.equal(await write.execute({ path, content: "" }), `Created ${path} (0 bytes)`);
	assert.equal(existsSync(path), true);
	assert.equal(await readFile(path, "utf8"), "");
});

test("byte count is true UTF-8, not JS string length", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "emoji.txt");
	// "a😀" is 3 UTF-16 code units but 5 UTF-8 bytes (1 + 4).
	assert.equal(await write.execute({ path, content: "a😀" }), `Created ${path} (5 bytes)`);
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
