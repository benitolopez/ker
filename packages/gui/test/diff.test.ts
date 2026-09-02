import { assert, test } from "vitest";
import { parsePatch } from "../src/diff.ts";

test("parses line numbers and counts across multiple hunks", () => {
	const parsed = parsePatch(
		"--- file.ts\n+++ file.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n@@ -10,2 +10,3 @@\n ten\n+eleven\n twelve\n",
	);

	assert.equal(parsed.valid, true);
	assert.equal(parsed.added, 2);
	assert.equal(parsed.removed, 1);
	assert.deepEqual(parsed.rows, [
		{ type: "context", oldLine: 1, newLine: 1, text: "one" },
		{ type: "del", oldLine: 2, text: "two" },
		{ type: "add", newLine: 2, text: "TWO" },
		{ type: "context", oldLine: 10, newLine: 10, text: "ten" },
		{ type: "add", newLine: 11, text: "eleven" },
		{ type: "context", oldLine: 11, newLine: 12, text: "twelve" },
	]);
});

test("attaches a no-newline marker to the preceding row", () => {
	const parsed = parsePatch(
		"--- file.ts\n+++ file.ts\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
	);

	assert.deepEqual(parsed.rows, [
		{ type: "del", oldLine: 1, text: "old", noNewline: true },
		{ type: "add", newLine: 1, text: "new", noNewline: true },
	]);
});

test("strips carriage returns from CRLF patch rows", () => {
	const parsed = parsePatch("--- file.ts\n+++ file.ts\n@@ -1 +1 @@\n-old\r\n+new\r\n");

	assert.equal(parsed.valid, true);
	assert.deepEqual(parsed.rows, [
		{ type: "del", oldLine: 1, text: "old" },
		{ type: "add", newLine: 1, text: "new" },
	]);
});

test("marks an unrecognized patch line invalid", () => {
	assert.equal(parsePatch("not a patch").valid, false);
});
