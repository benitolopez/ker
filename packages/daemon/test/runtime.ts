import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningNode, runNode } from "@ker-ai/node";
import { DEFAULT_PORT } from "@ker-ai/protocol";
import { createServer } from "@ker-ai/server";
import { createDaemon, type Daemon, type DaemonOptions } from "../src/index.ts";

export interface TestRuntime {
	server: Daemon;
	url: string;
	headers: Record<string, string>;
	stop(): Promise<void>;
}

export async function startTestRuntime(options: DaemonOptions): Promise<TestRuntime> {
	const mode = process.env.KER_TEST_MODE === "remote" ? "remote" : "bundled";
	const auth = process.env.KER_TEST_AUTH === "device";
	const port = auth ? await allocatePort() : 0;
	const publicUrl = auth ? `https://127.0.0.1:${port}` : undefined;
	const server =
		mode === "bundled"
			? createDaemon({ ...options, publicUrl })
			: createServer({
					sessionDir: options.sessionDir,
					catalogPath: options.catalogPath,
					eventTailSize: options.eventTailSize,
					guiDir: options.guiDir,
					publicUrl,
				});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
	const url = `http://127.0.0.1:${(address as AddressInfo).port}`;
	await server.ready;
	const headers: Record<string, string> = { host: auth ? `127.0.0.1:${port}` : `127.0.0.1:${DEFAULT_PORT}` };
	if (auth) {
		const pairing = server.plane.createPairing();
		const claimed = server.plane.claimPairing(pairing.code, "test-device");
		if (typeof claimed === "string") throw new Error(claimed);
		headers.authorization = `Bearer ${claimed.token}`;
	}
	const spoolDir = mode === "remote" ? await mkdtemp(join(tmpdir(), "ker-test-spool-")) : undefined;
	const node = spoolDir ? await startRemoteNode(server, url, options, spoolDir) : undefined;
	let stopped = false;
	return {
		server,
		url,
		headers,
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

async function allocatePort(): Promise<number> {
	const server = createTcpServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test port allocation failed");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}
