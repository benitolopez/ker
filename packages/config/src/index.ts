import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "gpt-5.4-mini";

// The model's reasoning effort. Left unset, no effort is sent, so the model does no reasoning and
// returns no summary; set a level to turn thinking on.
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Config {
	apiKey?: string;
	model: string;
	reasoningEffort?: ReasoningEffort;
}

// Load the user-owned config: the model, an optional API key (file value, then OPENAI_API_KEY), and an
// optional reasoning effort. A missing key is not an error here, because an OAuth login may cover it.
// resolveAuth raises the no-credentials error later, since it is the only place that sees both the key
// and the login.
export function loadConfig(): Config {
	const file = readConfigFile();
	return {
		apiKey: file.apiKey ?? process.env.OPENAI_API_KEY,
		model: file.model ?? DEFAULT_MODEL,
		reasoningEffort: file.reasoningEffort,
	};
}

interface ConfigFile {
	apiKey?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
}

// A missing file returns an empty object, so env and defaults apply. Malformed JSON throws.
function readConfigFile(): ConfigFile {
	const dir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	const path = join(dir, "ker", "config.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	try {
		return JSON.parse(raw) as ConfigFile;
	} catch {
		throw new Error(`Invalid JSON in ${path}`);
	}
}
