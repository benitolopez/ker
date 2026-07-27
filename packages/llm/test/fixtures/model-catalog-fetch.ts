const trackedModels = [
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

const models = Object.fromEntries(trackedModels.map((id) => [id, { limit: { input: 272_000, output: 128_000 } }]));
const scenario = process.env.KER_MODEL_CATALOG_SCENARIO;
if (scenario === "missing") delete models["gpt-5.6-terra"];
if (scenario === "undersized") models["gpt-5.4"].limit.input = 271_999;

globalThis.fetch = async () =>
	new Response(JSON.stringify({ openai: { models } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
