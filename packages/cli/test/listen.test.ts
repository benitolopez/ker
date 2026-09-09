import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Catalog } from "../../server/src/catalog.ts";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const execute = promisify(execFile);

test("listen commands reject unsafe binds and malformed flags before starting", async () => {
	for (const args of [
		["server", "--host", "0.0.0.0"],
		["daemon", "--public-url", "http://ker.test"],
		["server", "--port"],
		["daemon", "--unknown", "value"],
	]) {
		await assert.rejects(
			execute(process.execPath, [cliPath, ...args], { env: { ...process.env, KER_PUBLIC_URL: "" } }),
			(error) => {
				assert(error instanceof Error && "code" in error && "stderr" in error);
				assert.equal(error.code, 1);
				assert.match(String(error.stderr), /ker: /);
				return true;
			},
		);
	}
});

test("ker pair refuses a missing catalog without creating files or directories", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-cli-pair-missing-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const path of [join(root, "catalog.db"), join(root, "missing", "catalog.db")]) {
		const env = { ...process.env, KER_CATALOG_PATH: path };
		await assert.rejects(execute(process.execPath, [cliPath, "pair"], { env }), (error) => {
			assert(error instanceof Error && "code" in error && "stderr" in error && "stdout" in error);
			assert.equal(error.code, 1);
			assert.equal(error.stdout, "");
			assert(String(error.stderr).includes(`ker: no catalog at ${path}; start the server first\n`));
			return true;
		});
		assert.deepEqual(await readdir(root), []);
	}
});

test("ker pair prints a claimable fragment link, expiry, and terminal QR and refuses local mode", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ker-cli-pair-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "catalog.db");
	const env = { ...process.env, KER_CATALOG_PATH: path };
	const catalog = Catalog.open(path);
	t.after(() => catalog.close());
	await assert.rejects(execute(process.execPath, [cliPath, "pair"], { env }), (error) => {
		assert(error instanceof Error && "stderr" in error);
		assert.match(String(error.stderr), /pairing needs a server started with --public-url/);
		return true;
	});
	catalog.setSetting("public_url", "https://ker.test");
	const { stdout } = await execute(process.execPath, [cliPath, "pair"], { env });
	const [url, expiry, ...qr] = stdout.split("\n");
	assert.match(url, /^https:\/\/ker.test\/#\/pair\/[a-f0-9]{64}$/);
	assert.match(expiry, /^expires \d{4}-\d{2}-\d{2}T/);
	assert(qr.join("\n").length > 100);
	assert.equal(catalog.consumeOneTimeToken("device", new URL(url).hash.slice("#/pair/".length)), "ok");
});

for (const mode of ["server", "daemon"]) {
	test(`${mode} listens with the supplied flags and records its public URL`, { timeout: 10_000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "ker-cli-listen-"));
		const probe = createServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		assert(address && typeof address !== "string");
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const path = join(root, "catalog.db");
		const child = spawn(
			process.execPath,
			[cliPath, mode, "--host", "127.0.0.1", "--port", String(address.port), "--public-url", "https://ker.test"],
			{
				env: {
					...process.env,
					KER_CATALOG_PATH: path,
					KER_SESSION_DIR: join(root, "sessions"),
					KER_NODE_PATH: join(root, "node.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		t.after(async () => {
			child.kill("SIGTERM");
			await exited;
			await rm(root, { recursive: true, force: true });
		});
		await new Promise<void>((resolve, reject) => {
			const output: string[] = [];
			child.stderr.on("data", (chunk: Buffer) => {
				output.push(chunk.toString());
				if (!output.join("").includes("expecting a TLS-terminating proxy")) return;
				assert.match(output.join(""), new RegExp(`ker ${mode} listening on http://127.0.0.1:${address.port}`));
				resolve();
			});
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`CLI exited with ${code}: ${output.join("")}`)));
		});
		const catalog = Catalog.open(path);
		assert.equal(catalog.getSetting("public_url"), "https://ker.test");
		catalog.close();
	});
}
