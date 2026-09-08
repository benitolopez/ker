import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningNode, runNode } from "@ker-ai/node";
import { createServer } from "@ker-ai/server";
import { createDaemon, type Daemon, type DaemonOptions } from "../src/index.ts";

export interface TestRuntime {
	server: Daemon;
	url: string;
	stop(): Promise<void>;
}

export async function startTestRuntime(options: DaemonOptions): Promise<TestRuntime> {
	const mode = process.env.KER_TEST_MODE === "remote" ? "remote" : "bundled";
	const server =
		mode === "bundled"
			? createDaemon(options)
			: createServer({
					sessionDir: options.sessionDir,
					catalogPath: options.catalogPath,
					eventTailSize: options.eventTailSize,
					guiDir: options.guiDir,
				});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
	const url = `http://127.0.0.1:${(address as AddressInfo).port}`;
	const spoolDir = mode === "remote" ? await mkdtemp(join(tmpdir(), "ker-test-spool-")) : undefined;
	const node = spoolDir ? await startRemoteNode(server, url, options, spoolDir) : undefined;
	let stopped = false;
	return {
		server,
		url,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			await node?.shutdown();
			await server.shutdown();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			if (spoolDir) await rm(spoolDir, { recursive: true, force: true });
		},
	};
}

async function startRemoteNode(
	server: Daemon,
	url: string,
	options: DaemonOptions,
	spoolDir: string,
): Promise<RunningNode> {
	await server.ready;
	const nodePath = options.nodePath;
	if (!nodePath) throw new Error("Remote tests require a node path");
	const enrollment = server.plane.createEnrollment(url);
	return runNode({
		serverUrl: url,
		token: enrollment.token,
		nodePath,
		spoolDir,
		harnessFactory: options.harnessFactory,
		definition: options.definition,
		recoveryWindowMinutes: options.recoveryWindowMinutes,
		compaction: options.compaction,
		onStatus: () => undefined,
	});
}
