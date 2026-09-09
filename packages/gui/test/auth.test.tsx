import { createClient, type Result } from "@ker-ai/client";
import type * as Protocol from "@ker-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, assert, test, vi } from "vitest";
import { App } from "../src/App.tsx";
import { api, observeUnauthorized } from "../src/api.ts";
import { DevicesScreen } from "../src/screens/devices.tsx";
import { deviceNameHint, PairScreen } from "../src/screens/pair.tsx";
import { ProjectsScreen } from "../src/screens/projects.tsx";
import { auth, createAuthStore } from "../src/store/auth.ts";

const phone: Protocol.Device = {
	id: "phone",
	name: "Phone",
	createdAt: "2026-09-09T12:00:00.000Z",
	lastSeenAt: "2026-09-09T12:01:00.000Z",
	current: true,
};
const unauthorized = { ok: false, status: 401, error: { code: "unauthorized" } } as const;

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	auth.setPaired();
	window.location.hash = "";
});

test("the auth store loads health once and preserves pairing changes while health is pending", async () => {
	const store = createAuthStore();
	const pending = Promise.withResolvers<Result<Protocol.Health>>();
	const health = vi.fn(() => pending.promise);
	const changed = vi.fn();
	const unsubscribe = store.subscribe(changed);
	const first = store.load(health);
	assert.equal(store.load(health), first);
	store.setUnpaired();
	pending.resolve({ ok: true, status: 200, value: { name: "ker", protocol: "26", auth: "device" } });
	await first;
	assert.equal(health.mock.calls.length, 1);
	assert.deepEqual(store.getSnapshot(), { mode: "device", unpaired: true });
	store.setPaired();
	assert.equal(store.getSnapshot().unpaired, false);
	assert.equal(changed.mock.calls.length, 3);
	unsubscribe();
});

test("the API observes JSON, downloads, and SSE 401 results while keeping synchronous paths", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ code: "unauthorized" }, { status: 401 })),
	);
	try {
		const client = observeUnauthorized(createClient({ baseUrl: "" }));
		assert.equal(client.exportProjectPath("project/one"), "/projects/project%2Fone/export");
		for (const call of [
			() => client.listProjects(),
			() => client.exportProject("project"),
			() => client.subscribe("session", { epoch: "epoch", sequence: 0 }),
		]) {
			auth.setPaired();
			await call();
			assert.equal(auth.getSnapshot().unpaired, true);
		}
		assert.equal(client.listDevices, client.listDevices);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("App shows the not-paired screen after an API 401 and still opens pairing links", async () => {
	window.location.hash = "#/projects";
	vi.spyOn(api, "health").mockResolvedValue({
		ok: true,
		status: 200,
		value: { name: "ker", protocol: "26", auth: "device" },
	});
	vi.spyOn(api, "listProjects").mockImplementation(async () => {
		auth.setUnpaired();
		return unauthorized;
	});
	vi.spyOn(api, "listDevices").mockResolvedValue(unauthorized);
	render(<App />);
	await screen.findByRole("heading", { name: "This device is not paired" });
	assert(screen.getByText(/Open a pairing link/));
	assert(screen.getByText("ker pair"));
	await act(async () => {
		window.location.hash = "#/pair/code";
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
	await screen.findByLabelText("Device name");
});

test("pairing prefills a name, claims the code, clears unpaired state, and replaces the fragment", async () => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla iPhone");
	const replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
	const claim = vi.fn(
		async (_input: Protocol.ClaimPairingRequest): Promise<Result<Protocol.Device>> => ({
			ok: true,
			status: 201,
			value: phone,
		}),
	);
	auth.setUnpaired();
	render(<PairScreen claimPairing={claim} code="one-time-code" listDevices={async () => unauthorized} />);
	const name = (await screen.findByLabelText("Device name")) as HTMLInputElement;
	assert.equal(name.value, "iPhone");
	fireEvent.change(name, { target: { value: "Personal phone" } });
	fireEvent.click(screen.getByRole("button", { name: "Pair this device" }));
	await waitFor(() => assert.deepEqual(claim.mock.calls, [[{ code: "one-time-code", name: "Personal phone" }]]));
	assert.equal(auth.getSnapshot().unpaired, false);
	assert.deepEqual(replace.mock.calls, [["#/projects"]]);
});

test("pairing explains expired links and local mode", async () => {
	for (const [status, message] of [
		[410, "This link expired or was already used. Ask for a new one."],
		[409, "Pairing is off: this server runs in local mode."],
	] as const) {
		const view = render(
			<PairScreen
				claimPairing={async () => ({ ok: false, status, error: { code: "refused" } })}
				code="code"
				listDevices={async () => unauthorized}
			/>,
		);
		await screen.findByLabelText("Device name");
		fireEvent.click(screen.getByRole("button", { name: "Pair this device" }));
		await screen.findByText(message);
		view.unmount();
	}
});

test("an already-paired browser continues without spending the pairing code", async () => {
	const claim = vi.fn();
	const replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
	render(
		<PairScreen
			claimPairing={claim}
			code="code"
			listDevices={async () => ({ ok: true, status: 200, value: { devices: [phone] } })}
		/>,
	);
	await screen.findByRole("heading", { name: "This device is already paired" });
	assert.equal(screen.queryByLabelText("Device name"), null);
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	assert.deepEqual(replace.mock.calls, [["#/projects"]]);
	assert.equal(claim.mock.calls.length, 0);
});

test("device name hints cover the six platforms", () => {
	for (const [agent, expected] of [
		["iPhone", "iPhone"],
		["iPad", "iPad"],
		["Android Linux", "Android"],
		["Macintosh", "Mac"],
		["Windows NT", "Windows"],
		["Linux", "Linux"],
		["unknown", "My device"],
	])
		assert.equal(deviceNameHint(agent), expected);
});

test("Devices lists dates and the current device, renders a real QR, copies the link, and confirms revocation", async () => {
	const other = { ...phone, id: "laptop", name: "Laptop", current: false };
	const list = vi.fn(
		async (): Promise<Result<Protocol.ListDevicesResponse>> => ({
			ok: true,
			status: 200,
			value: { devices: [phone, other] },
		}),
	);
	const pairing = { code: "code", url: "https://ker.test/#/pair/code", expiresAt: "2026-09-09T12:15:00.000Z" };
	const revoke = vi.fn(
		async (_id: string): Promise<Result<Protocol.Device>> => ({ ok: true, status: 200, value: other }),
	);
	render(
		<DevicesScreen
			createPairing={async () => ({ ok: true, status: 201, value: pairing })}
			listDevices={list}
			revokeDevice={revoke}
		/>,
	);
	await screen.findByText("Laptop");
	assert(screen.getByText("This device"));
	assert.equal(screen.getAllByText(/^Paired /).length, 2);
	assert.equal(screen.getAllByText(/^Last seen /).length, 2);
	fireEvent.click(screen.getByRole("button", { name: "Pair device" }));
	await screen.findByText(pairing.url);
	const qr = await screen.findByRole("img", { name: "Pairing QR code" });
	assert.match(qr.getAttribute("src") ?? "", /^data:image\/png;base64,/);
	assert(screen.getByText(/expires in 15 minutes/));
	fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
	await screen.findByText(/Copied|Link selected/);
	fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[1]);
	assert.equal(revoke.mock.calls.length, 0);
	assert(screen.getByText("Revoke Laptop?"));
	fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
	await waitFor(() => assert.deepEqual(revoke.mock.calls, [["laptop"]]));
	assert.equal(auth.getSnapshot().unpaired, false);
	assert.equal(list.mock.calls.length, 2);
});

test("revoking the current device marks the browser unpaired", async () => {
	render(
		<DevicesScreen
			listDevices={async () => ({ ok: true, status: 200, value: { devices: [phone] } })}
			revokeDevice={async () => ({ ok: true, status: 200, value: phone })}
		/>,
	);
	await screen.findByText("Phone");
	fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
	fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
	await waitFor(() => assert.equal(auth.getSnapshot().unpaired, true));
});

test("the Projects header shows Devices only in device mode", async () => {
	for (const mode of ["local", "device"] as const) {
		const state = { mode, unpaired: false };
		vi.spyOn(auth, "getSnapshot").mockReturnValue(state);
		const view = render(
			<ProjectsScreen listProjects={async () => ({ ok: true, status: 200, value: { projects: [] } })} />,
		);
		await screen.findByText("No projects yet");
		assert.equal(screen.queryByRole("link", { name: "Devices" }) !== null, mode === "device");
		view.unmount();
		vi.restoreAllMocks();
	}
});
