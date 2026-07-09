import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateTail } from "../src/index.ts";

test("keeps short output whole", () => {
	assert.deepEqual(truncateTail("a\nb\nc"), { text: "a\nb\nc", truncated: false, shown: 3, total: 3 });
});

test("drops a single trailing newline so it isn't counted as a line", () => {
	assert.deepEqual(truncateTail("a\nb\n"), { text: "a\nb", truncated: false, shown: 2, total: 2 });
});

test("empty output has no lines", () => {
	assert.deepEqual(truncateTail(""), { text: "", truncated: false, shown: 0, total: 0 });
});

test("keeps the last 2000 lines when the line cap trips", () => {
	const raw = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
	const out = truncateTail(raw);
	assert.equal(out.truncated, true);
	assert.equal(out.total, 2500);
	assert.equal(out.shown, 2000);
	const lines = out.text.split("\n");
	assert.equal(lines[0], "line501");
	assert.equal(lines[1999], "line2500");
});

test("truncates at the 50KB byte cap before the line cap when lines are large", () => {
	const big = "x".repeat(1024);
	const raw = Array.from({ length: 200 }, () => big).join("\n");
	const out = truncateTail(raw);
	assert.equal(out.truncated, true);
	assert.ok(out.shown < 200);
	assert.ok(Buffer.byteLength(out.text, "utf8") <= 50 * 1024);
});

test("slices a single trailing line that alone exceeds the byte cap, keeping its end", () => {
	const huge = "y".repeat(60 * 1024);
	const out = truncateTail(huge);
	assert.equal(out.truncated, true);
	assert.equal(out.total, 1);
	assert.equal(out.shown, 1);
	assert.ok(Buffer.byteLength(out.text, "utf8") <= 50 * 1024);
	assert.ok(huge.endsWith(out.text));
	assert.equal(out.text, "y".repeat(out.text.length));
});

test("slices an oversized multibyte line on a UTF-8 boundary, never mid-character", () => {
	const euro = "€"; // 3 bytes each
	const huge = euro.repeat(30 * 1024);
	const out = truncateTail(huge);
	assert.equal(out.truncated, true);
	assert.ok(Buffer.byteLength(out.text, "utf8") <= 50 * 1024);
	assert.ok(!out.text.includes("�")); // no replacement char from a split code point
	assert.equal(out.text, euro.repeat(out.text.length));
});
