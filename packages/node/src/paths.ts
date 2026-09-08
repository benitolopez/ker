import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";

export async function canonicalDirectory(cwd: string): Promise<string> {
	if (!isAbsolute(cwd)) throw new Error("Session cwd must be absolute");
	const canonicalCwd = await realpath(cwd);
	if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("Session cwd must be a directory");
	return canonicalCwd;
}

// Walks up to the nearest git root and keeps the directory when it is not in a repository.
export async function canonicalProjectRoot(canonicalCwd: string): Promise<string> {
	const root = parse(canonicalCwd).root;
	for (let candidate = canonicalCwd; ; candidate = dirname(candidate)) {
		try {
			await stat(join(candidate, ".git"));
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (candidate === root) return canonicalCwd;
	}
}

export function observeGitRemote(root: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", root, "config", "--local", "--get", "remote.origin.url"],
			{ encoding: "utf8" },
			(error, stdout) => {
				if (error) {
					resolve(null);
					return;
				}
				const remote = stdout.trim();
				resolve(remote || null);
			},
		);
	});
}
