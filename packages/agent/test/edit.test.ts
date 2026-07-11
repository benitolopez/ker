import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { applyEdit, tools } from "../src/index.ts";

function editTool() {
	const found = tools.find((t) => t.name === "edit");
	if (!found) throw new Error("edit tool not registered");
	return found;
}
const edit = editTool();

async function tempDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ker-edit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("replaces a unique occurrence and reports one replacement", () => {
	assert.deepEqual(applyEdit("hello world", "world", "there", false), { content: "hello there", count: 1 });
});

test("replaceAll replaces every occurrence and reports the count", () => {
	assert.deepEqual(applyEdit("a a a", "a", "b", true), { content: "b b b", count: 3 });
});

test("throws when old_string is not found", () => {
	assert.throws(() => applyEdit("hello", "xyz", "z", false), /Could not find old_string/);
});

test("throws on multiple matches without replaceAll, naming the count", () => {
	assert.throws(() => applyEdit("a a", "a", "b", false), /Found 2 occurrences/);
});

test("rejects an empty old_string and points at write", () => {
	assert.throws(() => applyEdit("hi", "", "x", false), /old_string must not be empty.*use write/);
});

test("rejects an identical old_string and new_string", () => {
	assert.throws(() => applyEdit("hi", "hi", "hi", false), /identical/);
});

test("rejects a replacement that differs only in line endings", () => {
	// old and new both normalize to "alpha\nbeta" and restore to the file's CRLF, so it is a no-op.
	assert.throws(() => applyEdit("alpha\r\nbeta\r\n", "alpha\nbeta", "alpha\r\nbeta", false), /identical/);
});

test("matches an LF old_string against a CRLF file and preserves CRLF endings", () => {
	const { content, count } = applyEdit("one\r\ntwo\r\nthree\r\n", "one\ntwo", "one\nTWO", false);
	assert.equal(count, 1);
	assert.equal(content, "one\r\nTWO\r\nthree\r\n");
});

test("strips the BOM for matching and restores it on write", () => {
	const { content, count } = applyEdit("\uFEFFfirst\nsecond\n", "first", "FIRST", false);
	assert.equal(count, 1);
	assert.equal(content, "\uFEFFFIRST\nsecond\n");
});

test("edits a file on disk and returns the success line", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "f.txt");
	await writeFile(path, "hello world", "utf8");
	assert.equal(await edit.execute({ path, old_string: "world", new_string: "there" }), `Edited ${path} (1 occurrence)`);
	assert.equal(await readFile(path, "utf8"), "hello there");
});

test("replaceAll on disk rewrites every occurrence", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "g.txt");
	await writeFile(path, "x x x", "utf8");
	assert.equal(
		await edit.execute({ path, old_string: "x", new_string: "y", replaceAll: true }),
		`Edited ${path} (3 occurrences)`,
	);
	assert.equal(await readFile(path, "utf8"), "y y y");
});

test("a non-unique match without replaceAll fails on disk", async (t) => {
	const dir = await tempDir(t);
	const path = join(dir, "h.txt");
	await writeFile(path, "x x", "utf8");
	await assert.rejects(edit.execute({ path, old_string: "x", new_string: "y" }), /Found 2 occurrences/);
});

test("a missing file surfaces as an error", async (t) => {
	const dir = await tempDir(t);
	await assert.rejects(edit.execute({ path: join(dir, "nope.txt"), old_string: "a", new_string: "b" }), /ENOENT/);
});

test("rejects bad argument types and an up-front identical edit", async () => {
	await assert.rejects(
		edit.execute({ path: "", old_string: "a", new_string: "b" }),
		/'path' must be a non-empty string/,
	);
	await assert.rejects(edit.execute({ path: "x", old_string: 42, new_string: "b" }), /'old_string' must be a string/);
	await assert.rejects(edit.execute({ path: "x", old_string: "a", new_string: 42 }), /'new_string' must be a string/);
	await assert.rejects(
		edit.execute({ path: "x", old_string: "a", new_string: "b", replaceAll: "yes" }),
		/'replaceAll' must be a boolean/,
	);
	await assert.rejects(edit.execute({ path: "x", old_string: "a", new_string: "a" }), /identical/);
});
