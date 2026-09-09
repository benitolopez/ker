import assert from "node:assert/strict";
import { test } from "node:test";
import { ListenOptionsError, resolveListenOptions } from "../src/listen.ts";

test("listen options use defaults, environment fallbacks, and flag precedence", () => {
	assert.deepEqual(resolveListenOptions({}, {}), { host: "127.0.0.1", port: 5537, publicUrl: undefined });
	const env = { KER_HOST: "0.0.0.0", KER_PORT: "8080", KER_PUBLIC_URL: "https://ker.test/" };
	assert.deepEqual(resolveListenOptions({}, env), {
		host: "0.0.0.0",
		port: 8080,
		publicUrl: new URL("https://ker.test"),
	});
	assert.deepEqual(resolveListenOptions({ host: "::1", port: "443", publicUrl: "https://other.test:8443" }, env), {
		host: "::1",
		port: 443,
		publicUrl: new URL("https://other.test:8443"),
	});
	for (const host of ["localhost", "127.0.0.1", "::1"]) assert.equal(resolveListenOptions({ host }, {}).host, host);
	for (const port of ["1", "65535"]) assert.equal(resolveListenOptions({ port }, {}).port, Number(port));
});

test("listen options refuse unprotected public binds and invalid addresses", () => {
	for (const host of ["0.0.0.0", "::", "192.168.1.2", "ker.test"]) {
		assert.throws(() => resolveListenOptions({ host }, {}), /needs --public-url/);
	}
	for (const port of ["0", "65536", "-1", "1.5", "abc", ""]) {
		assert.throws(() => resolveListenOptions({ port }, {}), ListenOptionsError);
	}
	for (const publicUrl of [
		"http://ker.test",
		"ker.test",
		"https://ker.test/path",
		"https://ker.test?query",
		"https://ker.test#fragment",
		"https://ker.test?",
		"https://ker.test#",
		"https://user@ker.test",
		"https://:password@ker.test",
		"",
	]) {
		assert.throws(
			() => resolveListenOptions({ publicUrl }, {}),
			(error) => error instanceof ListenOptionsError && error.message.includes("https origin"),
		);
	}
	assert.throws(() => resolveListenOptions({ host: "" }, {}), ListenOptionsError);
});
