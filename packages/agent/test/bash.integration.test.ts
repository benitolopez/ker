import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { tools } from "../src/index.ts";

function bashTool() {
	const found = tools.find((t) => t.name === "bash");
	if (!found) throw new Error("bash tool not registered");
	return found;
}
const bash = bashTool();

// Pids whose full command line matches the pattern. pgrep exits 1 when there are none, which
// execFileSync turns into a throw — treat that (and a missing pgrep) as "no matches".
function pidsMatching(pattern: string): string[] {
	try {
		return execFileSync("pgrep", ["-f", pattern]).toString().trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

test("a non-zero exit comes back as data, not a throw", async () => {
	assert.match(await bash.execute({ command: "exit 3" }), /\[exited with code 3\]/);
});

test(
	"a signal-terminated command throws with its output and signal",
	{ skip: process.platform === "win32" },
	async () => {
		await assert.rejects(bash.execute({ command: 'printf "before"; kill -TERM $$' }), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, "before\n\n[terminated by SIGTERM]");
			return true;
		});
	},
);

test("a command with no output returns the empty sentinel", async () => {
	assert.equal(await bash.execute({ command: "true" }), "(no output)");
});

test("stdin is closed so a stdin-reader gets EOF instead of blocking", { timeout: 15000 }, async () => {
	// `cat` with no file reads stdin; if stdin weren't "ignore" this would hang until the default timeout.
	assert.equal(await bash.execute({ command: "cat" }), "(no output)");
});

test("large output is tail-truncated with the full log spilled to a temp file", async () => {
	const out = await bash.execute({ command: "seq 1 100000" });
	const path = out.match(/full output: ([^\]]+)\]/)?.[1];
	assert.ok(path, "expected a temp-file path in the truncation notice");
	const full = await readFile(path, "utf8");
	const lines = full.split("\n").filter(Boolean);
	assert.equal(lines.length, 100000);
	assert.equal(lines[0], "1");
	assert.equal(lines.at(-1), "100000");
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
});

test("normal process exit removes its private spill directory", () => {
	const agentUrl = JSON.stringify(new URL("../src/index.ts", import.meta.url).href);
	const source = [
		`import { tools } from ${agentUrl}`,
		'const bash = tools.find((tool) => tool.name === "bash")',
		'if (!bash) throw new Error("bash tool not registered")',
		'const result = await bash.execute({ command: "seq 1 100000" })',
		'const marker = "full output: "',
		"const start = result.lastIndexOf(marker)",
		'process.stdout.write(result.slice(start + marker.length, result.indexOf("]", start)))',
	].join(";");
	const path = execFileSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(dirname(path)), false);
});

test("a timed-out command throws and its whole process group is killed", { timeout: 20000 }, async (t) => {
	// A distinctive sleep duration so pgrep can find an orphan without matching unrelated `sleep`s.
	const marker = `sleep ${900000 + Math.floor(Math.random() * 90000)}`;
	t.after(() => {
		for (const pid of pidsMatching(marker)) {
			try {
				process.kill(Number(pid), "SIGKILL");
			} catch {
				// already reaped
			}
		}
	});

	// The backgrounded `&` sleep is a grandchild only a process-group kill reaches; the foreground sleep
	// keeps the shell alive past the 1s timeout so there is something to kill.
	await assert.rejects(bash.execute({ command: `${marker} & ${marker}`, timeout: 1 }), /\[timed out after 1s\]/);

	// SIGTERM kills `sleep` at once; poll briefly to let the OS reap before asserting no survivors.
	let survivors = pidsMatching(marker);
	for (let i = 0; i < 30 && survivors.length > 0; i++) {
		await new Promise((r) => setTimeout(r, 100));
		survivors = pidsMatching(marker);
	}
	assert.deepEqual(survivors, [], "a backgrounded grandchild outlived the group kill");
});

test("an aborted command keeps partial output and kills its process group", { timeout: 20000 }, async (t) => {
	const marker = `sleep ${990000 + Math.floor(Math.random() * 9000)}`;
	t.after(() => {
		for (const pid of pidsMatching(marker)) {
			try {
				process.kill(Number(pid), "SIGKILL");
			} catch {}
		}
	});
	const controller = new AbortController();
	const execution = bash.execute({ command: `printf "before"; ${marker} & ${marker}` }, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 200));
	controller.abort();

	await assert.rejects(execution, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /^before/);
		assert.match(error.message, /\[aborted by user; command may have partially executed\]/);
		return true;
	});

	let survivors = pidsMatching(marker);
	for (let i = 0; i < 30 && survivors.length > 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		survivors = pidsMatching(marker);
	}
	assert.deepEqual(survivors, [], "a backgrounded grandchild outlived the abort");
});
