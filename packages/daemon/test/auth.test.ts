import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import * as Protocol from "@ker-ai/protocol";
import { type RouteDefinition, routes } from "@ker-ai/protocol/routes";
import { createPairingLink, createServer } from "@ker-ai/server";
import { Catalog } from "../../server/src/catalog.ts";
import { createDaemon } from "../src/index.ts";

const PUBLIC_URL = "https://ker.test";
const COOKIE_ATTRIBUTES = "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000";

for (const mode of ["bundled", "remote"] as const) {
	test(`${mode}: every private route and unknown path requires a device`, async (t) => {
		const running = await startServer(t, mode);
		for (const route of Object.values(routes) as RouteDefinition[]) {
			const path = route.path.replace(/\{[^}]+\}/g, "missing");
			const response = await running.call(path, { method: route.method });
			if (route.public) {
				assert.equal(response.status, route.method === "POST" ? 415 : 200, path);
				if (route.method === "GET") {
					const head = await running.call(path, { method: "HEAD" });
					assert.equal(head.status, 200, `HEAD ${path}`);
					assert.equal(head.body, "");
				}
				continue;
			}
			assert.equal(response.status, 401, path);
			assert.deepEqual(response.body, { code: "unauthorized" });
		}
		for (const path of ["/missing", "/sessions/%ZZ", "/devices/%ZZ", "/sessions/missing/events?epoch=&sequence=bad"]) {
			assert.equal((await running.call(path)).status, 401, path);
		}
		assert.equal((await running.call("/")).status, 200);
		assert.equal((await running.call("/assets/missing.js")).status, 404);
		assert.equal((await running.call("/", { method: "POST" })).status, 401);
		assert.equal((await running.call("/projects", { method: "HEAD" })).status, 401);
		assert.deepEqual((await running.call("/health")).body, {
			name: "ker",
			protocol: Protocol.PROTOCOL_VERSION,
			auth: "device",
		});
		assert.equal((await running.call("/devices", { headers: { authorization: "Bearer unknown" } })).status, 401);
		assert.equal((await running.call("/devices", { headers: { cookie: "ker_device=unknown" } })).status, 401);
	});

	test(`${mode}: pairing, cookie renewal, CSRF, bearer access, and revocation`, async (t) => {
		const running = await startServer(t, mode);
		const pairing = running.server.plane.createPairing();
		assert.equal(pairing.url, `${PUBLIC_URL}/#/pair/${pairing.code}`);
		const claimed = await running.call("/devices/pairings/claim", {
			method: "POST",
			body: { code: pairing.code, name: "Phone" },
		});
		assert.equal(claimed.status, 201);
		const device = claimed.body as Protocol.Device;
		const cookie = claimed.cookies[0];
		assert.match(cookie, /^ker_device=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000$/);
		assert.equal(device.current, true);
		assert.equal(device.name, "Phone");
		assert.equal("token" in device, false);
		const token = cookie.slice("ker_device=".length, cookie.indexOf(";"));
		const cookieHeader = `unrelated=value; ker_device=${token}; another=value`;
		for (const path of ["/projects", "/sessions/missing/events"]) {
			assert.equal((await running.call(path, { method: "HEAD", headers: { cookie: cookieHeader } })).status, 404);
		}
		const listed = await running.call("/devices", { headers: { cookie: cookieHeader } });
		assert.equal(listed.status, 200);
		assert.deepEqual(listed.cookies, [`ker_device=${token}${COOKIE_ATTRIBUTES}`]);
		const current = (listed.body as Protocol.ListDevicesResponse).devices[0];
		assert.equal(current?.current, true);
		assert(current?.lastSeenAt);
		for (const path of ["/devices/pairings", "/nodes/enrollments"]) {
			assert.equal((await running.call(path, { method: "POST", headers: { cookie: cookieHeader } })).status, 403);
			assert.equal(
				(
					await running.call(path, {
						method: "POST",
						headers: { cookie: cookieHeader, origin: "https://foreign.test" },
					})
				).status,
				403,
			);
			assert.equal(
				(await running.call(path, { method: "POST", headers: { cookie: cookieHeader, origin: PUBLIC_URL } })).status,
				201,
			);
			assert.equal(
				(await running.call(path, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status,
				201,
			);
		}
		const enrollment = await running.call("/nodes/enrollments", {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		});
		assert.match((enrollment.body as Protocol.Enrollment).command, /^ker node --server https:\/\/ker.test --token /);
		assert.equal(
			(await running.call("/devices", { headers: { authorization: "Bearer invalid", cookie: cookieHeader } })).status,
			401,
		);
		assert.equal((await running.call("/devices", { headers: { authorization: `Bearer ${token}` } })).cookies.length, 0);
		const secondPairing = running.server.plane.createPairing();
		const second = running.server.plane.claimPairing(secondPairing.code, "Laptop");
		assert.notEqual(typeof second, "string");
		if (typeof second === "string") throw new Error(second);
		const secondHeaders = { authorization: `Bearer ${second.token}` };
		const otherList = await running.call("/devices", { headers: secondHeaders });
		assert.deepEqual(
			(otherList.body as Protocol.ListDevicesResponse).devices.map((item) => item.current),
			[false, true],
		);
		const revoked = await running.call(`/devices/${device.id}`, { method: "DELETE", headers: secondHeaders });
		assert.equal(revoked.status, 200);
		assert.equal(revoked.cookies.length, 0);
		assert.equal((await running.call("/devices", { headers: { cookie: cookieHeader } })).status, 401);
		assert.equal(
			(await running.call(`/devices/${device.id}`, { method: "DELETE", headers: secondHeaders })).status,
			404,
		);
		const self = await running.call(`/devices/${second.device.id}`, { method: "DELETE", headers: secondHeaders });
		assert.equal(self.status, 200);
		assert.equal((self.body as Protocol.Device).current, true);
		assert.deepEqual(self.cookies, ["ker_device=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"]);
		assert.equal((await running.call("/devices", { headers: secondHeaders })).status, 401);
	});
}

test("Host and Origin are pinned even on public routes and forwarded headers are ignored", async (t) => {
	const running = await startServer(t);
	for (const headers of [
		{ host: "127.0.0.1:5537" },
		{ origin: "https://foreign.test" },
		{ host: "foreign.test", "x-forwarded-host": "ker.test" },
	] as Array<Record<string, string>>) {
		assert.equal((await running.call("/health", { headers })).status, 403);
	}
	assert.equal(
		(await running.call("/health", { headers: { "x-forwarded-host": "foreign.test", "x-forwarded-proto": "http" } }))
			.status,
		200,
	);
	const socket = new WebSocket(`${running.url.replace("http:", "ws:")}/nodes/socket`);
	await new Promise<void>((resolve) => socket.addEventListener("error", () => resolve(), { once: true }));
	assert.notEqual(socket.readyState, WebSocket.OPEN);
});

test("pairing rejects invalid, expired, spent, and node codes and validates the name", async (t) => {
	const running = await startServer(t);
	const claim = (code: string, name = "Phone") =>
		running.call("/devices/pairings/claim", { method: "POST", body: { code, name } });
	const expired = running.server.plane.createPairing();
	const database = new DatabaseSync(running.catalogPath);
	database.exec("UPDATE one_time_token SET expires_at = '2020-01-01'");
	database.close();
	const nodeCode = running.server.plane.createEnrollment("http://wrong").token;
	for (const code of ["unknown", expired.code, nodeCode]) {
		const response = await claim(code);
		assert.equal(response.status, 410);
		assert.deepEqual(response.body, { code: "pairing_invalid" });
	}
	const pairing = running.server.plane.createPairing();
	for (const name of ["", "x".repeat(81)]) {
		const response = await claim(pairing.code, name);
		assert.equal(response.status, 400);
		assert.deepEqual(response.body, { code: "invalid_pairing" });
	}
	const responses = await Promise.all([claim(pairing.code), claim(pairing.code)]);
	assert.deepEqual(responses.map((response) => response.status).sort(), [201, 410]);
});

test("the catalog setting follows the server mode and host pairing works with the server running", async (t) => {
	const running = await startServer(t);
	const catalog = Catalog.open(running.catalogPath);
	assert.equal(catalog.getSetting("public_url"), PUBLIC_URL);
	catalog.close();
	const pairing = createPairingLink(running.catalogPath);
	assert(typeof pairing !== "string", "Expected remote pairing");
	const code = new URL(pairing.url).hash.slice("#/pair/".length);
	assert.equal(
		(await running.call("/devices/pairings/claim", { method: "POST", body: { code, name: "Recovery" } })).status,
		201,
	);
	await running.stop();
	const local = createServer({ catalogPath: running.catalogPath, sessionDir: running.sessionDir });
	await local.ready;
	assert.equal(createPairingLink(running.catalogPath), "local");
	assert.equal(local.plane.authMode(), "local");
	await local.shutdown();
	const localRuntime = await startServer(t, "remote", null);
	for (const path of ["/health", "/openapi.json"]) {
		const head = await localRuntime.call(path, { method: "HEAD" });
		assert.equal(head.status, 200, `HEAD ${path}`);
		assert.equal(head.body, "");
	}
	for (const path of ["/projects", "/sessions/missing/events"]) {
		assert.equal((await localRuntime.call(path, { method: "HEAD" })).status, 404);
	}
	assert.equal((await localRuntime.call("/devices/pairings", { method: "POST" })).status, 409);
	assert.equal(
		(await localRuntime.call("/devices/pairings/claim", { method: "POST", body: { code: "code", name: "Phone" } }))
			.status,
		409,
	);
});

test("authentication touches last seen at most once per minute without caching authorization", async (t) => {
	const running = await startServer(t);
	const plane = running.server.plane;
	const pairing = plane.createPairing();
	const claimed = plane.claimPairing(pairing.code, "Phone");
	if (typeof claimed === "string") throw new Error(claimed);
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const first = plane.authenticateDevice(claimed.token);
	assert(first?.lastSeenAt);
	t.mock.method(Date, "now", () => now + 59_999);
	assert.equal(plane.authenticateDevice(claimed.token)?.lastSeenAt, first.lastSeenAt);
	t.mock.method(Date, "now", () => now + 60_000);
	assert.notEqual(plane.authenticateDevice(claimed.token)?.lastSeenAt, first.lastSeenAt);
	plane.revokeDevice(claimed.device.id);
	assert.equal(plane.authenticateDevice(claimed.token), undefined);
});

interface CallOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: object;
}

async function startServer(
	t: TestContext,
	mode: "bundled" | "remote" = "remote",
	publicUrl: string | null = PUBLIC_URL,
) {
	const root = await mkdtemp(join(tmpdir(), "ker-device-auth-"));
	const catalogPath = join(root, "catalog.db");
	const sessionDir = join(root, "sessions");
	const options = { catalogPath, sessionDir, publicUrl: publicUrl ?? undefined, nodePath: join(root, "node.json") };
	const server = mode === "bundled" ? createDaemon(options) : createServer(options);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	await server.ready;
	const address = server.address();
	assert(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	const stop = async () => {
		if (!server.listening) return;
		await server.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	};
	t.after(async () => {
		await stop();
		await rm(root, { recursive: true, force: true });
	});
	const call = (path: string, options: CallOptions = {}) =>
		new Promise<{ status: number; body: unknown; cookies: string[] }>((resolve, reject) => {
			const req = request(
				`${url}${path}`,
				{
					method: options.method,
					headers: {
						host: publicUrl ? new URL(publicUrl).host : `127.0.0.1:${address.port}`,
						...(options.body ? { "content-type": "application/json" } : {}),
						...options.headers,
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						resolve({
							status: res.statusCode ?? 0,
							body:
								text && res.headers["content-type"]?.startsWith("application/json")
									? (JSON.parse(text) as unknown)
									: text,
							cookies: res.headers["set-cookie"] ?? [],
						});
					});
				},
			);
			req.on("error", reject);
			req.end(options.body ? JSON.stringify(options.body) : undefined);
		});
	return { server, url, catalogPath, sessionDir, stop, call };
}
