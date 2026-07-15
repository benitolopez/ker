import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRead } from "../src/index.ts";

const path = "example.txt";

test("prefixes each line with its 1-indexed number", () => {
	assert.equal(formatRead("alpha\nbeta\ngamma", undefined, undefined, path), "1: alpha\n2: beta\n3: gamma");
});

test("drops a single trailing newline so it isn't counted as a blank line", () => {
	assert.equal(formatRead("alpha\nbeta\n", undefined, undefined, path), "1: alpha\n2: beta");
});

test("keeps a genuine trailing blank line", () => {
	assert.equal(formatRead("alpha\n\n", undefined, undefined, path), "1: alpha\n2: ");
});

test("returns a placeholder for an empty file", () => {
	assert.equal(formatRead("", undefined, undefined, path), "(empty file)");
});

test("offset starts reading at a 1-indexed line", () => {
	assert.equal(formatRead("a\nb\nc\nd", 3, undefined, path), "3: c\n4: d");
});

test("limit caps the lines shown and notes the offset to continue from", () => {
	assert.equal(
		formatRead("a\nb\nc\nd", 1, 2, path),
		"1: a\n2: b\n\n[showing lines 1-2 of 4; use offset=3 to continue]",
	);
});

test("offset past end of file throws", () => {
	assert.throws(() => formatRead("a\nb", 5, undefined, path), /beyond end of file \(2 lines\)/);
});

test("truncates at the 2000-line cap and points at the next offset", () => {
	const raw = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
	const out = formatRead(raw, undefined, undefined, path);
	const lines = out.split("\n");
	assert.equal(lines[0], "1: line1");
	assert.equal(lines[1999], "2000: line2000");
	assert.match(out, /\[showing lines 1-2000 of 2500; use offset=2001 to continue\]/);
});

test("truncates at the 50KB byte cap when lines are large", () => {
	const big = "x".repeat(1024);
	const raw = Array.from({ length: 200 }, () => big).join("\n");
	const out = formatRead(raw, undefined, undefined, path);
	assert.match(out, /use offset=\d+ to continue/);
	assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024);
});

test("slices an oversized first line at a UTF-8 boundary and points bash at the remainder", () => {
	const huge = "🙂".repeat(512 * 1024);
	const out = formatRead(huge, undefined, undefined, "fixtures/huge file's.txt");
	const separator = out.indexOf("\n\n[");
	const shown = out.slice("1: ".length, separator);
	const command = out.match(/tail -c \+(\d+)/);

	assert.ok(Buffer.byteLength(out, "utf8") <= 50 * 1024);
	assert.ok(shown.endsWith("🙂"));
	assert.ok(!shown.includes("�"));
	assert.ok(command);
	assert.equal(Number(command[1]), Buffer.byteLength(shown, "utf8") + 1);
	assert.ok(out.includes("-- 'fixtures/huge file'\\''s.txt' | head -c 51200"));
});

test("does not include a fragment when an oversized line follows complete lines", () => {
	const raw = `alpha\n${"🙂".repeat(512 * 1024)}`;
	const first = formatRead(raw, undefined, undefined, path);
	const second = formatRead(raw, 2, undefined, path);
	const separator = second.indexOf("\n\n[");
	const shown = second.slice("2: ".length, separator);
	const command = second.match(/tail -c \+(\d+)/);

	assert.equal(first, "1: alpha\n\n[showing lines 1-1 of 2; use offset=2 to continue]");
	assert.ok(command);
	assert.equal(Number(command[1]), Buffer.byteLength(`alpha\n${shown}`, "utf8") + 1);
	assert.ok(Buffer.byteLength(second, "utf8") <= 50 * 1024);
});
