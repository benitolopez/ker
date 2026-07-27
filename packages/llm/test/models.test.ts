import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Provider } from "../src/index.ts";
import { getModel } from "../src/index.ts";

const generator = fileURLToPath(new URL("../scripts/generate-models.ts", import.meta.url));
const catalogFixture = fileURLToPath(new URL("./fixtures/model-catalog-fetch.ts", import.meta.url));
const generatedSnapshot = fileURLToPath(new URL("../src/models.generated.ts", import.meta.url));
const publicModels = [
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
];
const codexModels = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];

test("looks up the tracked GPT-5 models with the working limits", () => {
	for (const [provider, ids] of [
		["openai", publicModels],
		["openai-codex", codexModels],
	] satisfies Array<[Provider, string[]]>) {
		for (const id of ids) {
			assert.deepEqual(getModel(provider, id), {
				provider,
				id,
				contextWindow: 272_000,
				maxOutputTokens: 128_000,
			});
		}
	}
});

test("leaves the GPT-5.6 alias and unknown model ids without guessed limits", () => {
	assert.deepEqual(getModel("openai", "gpt-5.6"), { provider: "openai", id: "gpt-5.6" });
	assert.deepEqual(getModel("openai-codex", "custom-model"), {
		provider: "openai-codex",
		id: "custom-model",
	});
});

test("rejects unsafe catalog changes without replacing the generated snapshot", () => {
	const before = readFileSync(generatedSnapshot);
	const scenarios = [
		{ name: "missing", error: "no longer contains tracked models: gpt-5.6-terra" },
		{ name: "undersized", error: "limits for gpt-5.4 are below the configured working limits" },
	];

	for (const scenario of scenarios) {
		const result = spawnSync(process.execPath, ["--import", catalogFixture, generator], {
			encoding: "utf8",
			env: { ...process.env, KER_MODEL_CATALOG_SCENARIO: scenario.name },
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, new RegExp(scenario.error));
		assert.deepEqual(readFileSync(generatedSnapshot), before);
	}
});
