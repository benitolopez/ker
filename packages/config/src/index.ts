import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "gpt-5.4-mini";

export interface Config {
	apiKey: string;
	model: string;
}

// Load the user-owned BYO-key config. File values win, then OPENAI_API_KEY, then the default
// model. Throws when no key can be found, since nothing downstream can run without one.
export function loadConfig(): Config {
	const file = readConfigFile();
	const apiKey = file.apiKey ?? process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error('No OpenAI API key found. Set OPENAI_API_KEY or add "apiKey" to ~/.config/ker/config.json.');
	}
	return { apiKey, model: file.model ?? DEFAULT_MODEL };
}

interface ConfigFile {
	apiKey?: string;
	model?: string;
}

// A missing file is fine (fall back to env/defaults); a malformed one is surfaced, not swallowed.
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
