import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the server source does not import execution packages", async () => {
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const sourceRoot = join(packageRoot, "src");
	const files = (await readdir(sourceRoot, { recursive: true })).filter((path) => path.endsWith(".ts"));
	const forbidden = /from ["']@ker-ai\/(?:engine|llm|agent|auth|config|node)(?:["'/])/;
	for (const file of files) {
		const source = await readFile(join(sourceRoot, file), "utf8");
		assert.doesNotMatch(source, forbidden, file);
	}

	const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	for (const dependency of [
		"@ker-ai/engine",
		"@ker-ai/llm",
		"@ker-ai/agent",
		"@ker-ai/auth",
		"@ker-ai/config",
		"@ker-ai/node",
	]) {
		assert.equal(manifest.dependencies?.[dependency], undefined);
	}
});
