import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { loadConfig } from "../src/index.ts";

test("uses compaction defaults when the config block is absent", async (t) => {
	const directory = await configDirectory(t);

	process.env.XDG_CONFIG_HOME = directory;
	await mkdir(join(directory, "ker"), { recursive: true });
	await writeFile(join(directory, "ker", "config.json"), "{}");

	assert.deepEqual(loadConfig().compaction, {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: 20_000,
		reasoningEffort: undefined,
		prune: true,
	});
});

test("merges partial compaction settings with defaults", async (t) => {
	const directory = await configDirectory(t);

	process.env.XDG_CONFIG_HOME = directory;
	await mkdir(join(directory, "ker"), { recursive: true });
	await writeFile(
		join(directory, "ker", "config.json"),
		JSON.stringify({
			compaction: { enabled: false, keepRecentTokens: 4_000, reasoningEffort: "xhigh", prune: false },
		}),
	);

	assert.deepEqual(loadConfig().compaction, {
		enabled: false,
		reserveTokens: 16_384,
		keepRecentTokens: 4_000,
		reasoningEffort: "xhigh",
		prune: false,
	});
});

async function configDirectory(t: TestContext): Promise<string> {
	const previous = process.env.XDG_CONFIG_HOME;
	const directory = await mkdtemp(join(tmpdir(), "ker-config-"));
	t.after(async () => {
		if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
		if (previous !== undefined) process.env.XDG_CONFIG_HOME = previous;
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}
