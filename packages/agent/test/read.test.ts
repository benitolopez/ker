import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRead } from "../src/index.ts";

test("prefixes each line with its 1-indexed number", () => {
	assert.equal(formatRead("alpha\nbeta\ngamma", undefined, undefined), "1: alpha\n2: beta\n3: gamma");
});

test("drops a single trailing newline so it isn't counted as a blank line", () => {
	assert.equal(formatRead("alpha\nbeta\n", undefined, undefined), "1: alpha\n2: beta");
});

test("keeps a genuine trailing blank line", () => {
	assert.equal(formatRead("alpha\n\n", undefined, undefined), "1: alpha\n2: ");
});

test("returns a placeholder for an empty file", () => {
	assert.equal(formatRead("", undefined, undefined), "(empty file)");
});

test("offset starts reading at a 1-indexed line", () => {
	assert.equal(formatRead("a\nb\nc\nd", 3, undefined), "3: c\n4: d");
});

test("limit caps the lines shown and notes the offset to continue from", () => {
	assert.equal(formatRead("a\nb\nc\nd", 1, 2), "1: a\n2: b\n\n[showing lines 1-2 of 4; use offset=3 to continue]");
});

test("offset past end of file throws", () => {
	assert.throws(() => formatRead("a\nb", 5, undefined), /beyond end of file \(2 lines\)/);
});

test("truncates at the 2000-line cap and points at the next offset", () => {
	const raw = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
	const out = formatRead(raw, undefined, undefined);
	const lines = out.split("\n");
	assert.equal(lines[0], "1: line1");
	assert.equal(lines[1999], "2000: line2000");
	assert.match(out, /\[showing lines 1-2000 of 2500; use offset=2001 to continue\]/);
});

test("truncates at the 50KB byte cap when lines are large", () => {
	const big = "x".repeat(1024);
	const raw = Array.from({ length: 200 }, () => big).join("\n");
	const out = formatRead(raw, undefined, undefined);
	assert.match(out, /use offset=\d+ to continue/);
	assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024 + 200);
});

test("always includes the first line even if it alone exceeds the byte cap", () => {
	const huge = "x".repeat(60 * 1024);
	assert.equal(formatRead(huge, undefined, undefined), `1: ${huge}`);
});
