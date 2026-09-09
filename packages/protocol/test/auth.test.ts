import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { ClaimPairingRequest, Health } from "../src/index.ts";
import { type RouteDefinition, routes } from "../src/routes.ts";

test("device routes and public access are explicit in the contract", () => {
	assert.equal(routes.listDevices.path, "/devices");
	assert.equal(routes.createPairing.method, "POST");
	assert.equal(routes.claimPairing.path, "/devices/pairings/claim");
	assert.equal(routes.revokeDevice.method, "DELETE");
	for (const [key, route] of Object.entries(routes) as Array<[string, RouteDefinition]>) {
		assert.equal(route.public === true, ["health", "openapi", "claimPairing"].includes(key));
		assert.equal(401 in route.responses, !route.public);
	}
	assert(Value.Check(Health, { name: "ker", protocol: "26", auth: "device" }));
	assert(Value.Check(Health, { name: "ker", protocol: "26", auth: "local" }));
	assert(!Value.Check(Health, { name: "ker", protocol: "26" }));
	assert(!Value.Check(Health, { name: "ker", protocol: "26", auth: "unknown" }));
});

test("pairing claims require a code and a bounded device name", () => {
	assert(Value.Check(ClaimPairingRequest, { code: "code", name: "iPhone" }));
	assert(Value.Check(ClaimPairingRequest, { code: "code", name: "x".repeat(80) }));
	for (const input of [
		{ code: "", name: "iPhone" },
		{ code: "code", name: "" },
		{ code: "code", name: "x".repeat(81) },
		{ code: "code" },
	]) {
		assert(!Value.Check(ClaimPairingRequest, input));
	}
});
