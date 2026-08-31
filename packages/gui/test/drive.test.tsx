import type { Result } from "@ker-ai/client";
import type * as Protocol from "@ker-ai/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, assert, test, vi } from "vitest";
import { SessionsScreen } from "../src/screens/sessions.tsx";
import { Composer, QueueStack, SessionHeader } from "../src/screens/transcript.tsx";

afterEach(cleanup);

test("the composer handles Enter, Shift+Enter, IME input, and multiline paste", async () => {
	const send = vi.fn(async (_text: string) => promptAdmission());
	render(<Composer queue={emptyQueue()} onSend={send} onStop={async (turnId) => cancellation(turnId)} />);
	const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
	assert.equal(document.activeElement, textarea);

	fireEvent.change(textarea, { target: { value: "first line\nsecond line" } });
	fireEvent.paste(textarea);
	fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
	fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
	assert.equal(send.mock.calls.length, 0);
	assert.equal(textarea.value, "first line\nsecond line");

	fireEvent.keyDown(textarea, { key: "Enter" });
	await waitFor(() => assert.equal(send.mock.calls.length, 1));
	assert.equal(send.mock.calls[0]?.[0], "first line\nsecond line");
	await waitFor(() => assert.equal(textarea.value, ""));
});

test("the composer morphs between disabled Send, Send, and Stop", async () => {
	const stop = vi.fn(async (turnId: string) => cancellation(turnId));
	const view = render(<Composer queue={emptyQueue()} onSend={async () => promptAdmission()} onStop={stop} />);
	const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
	assert.equal((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled, true);

	fireEvent.change(textarea, { target: { value: "queued work" } });
	assert.equal((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled, false);
	view.rerender(<Composer queue={runningQueue()} onSend={async () => promptAdmission()} onStop={stop} />);
	assert.equal((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled, false);

	fireEvent.change(textarea, { target: { value: "" } });
	fireEvent.keyDown(textarea, { key: "Enter" });
	assert.equal(stop.mock.calls.length, 0);
	fireEvent.click(screen.getByRole("button", { name: "Stop" }));
	await waitFor(() => assert.deepEqual(stop.mock.calls, [["turn-running"]]));
	view.rerender(<Composer queue={runningQueue("cancelling")} onSend={async () => promptAdmission()} onStop={stop} />);
	assert.equal((screen.getByRole("button", { name: "Cancelling…" }) as HTMLButtonElement).disabled, true);
});

test("the composer clears accepted text and keeps rejected text with guidance", async () => {
	const view = render(
		<Composer queue={emptyQueue()} onSend={async () => promptAdmission()} onStop={async (id) => cancellation(id)} />,
	);
	const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
	fireEvent.change(textarea, { target: { value: "accepted" } });
	fireEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => assert.equal(textarea.value, ""));

	view.rerender(
		<Composer
			queue={emptyQueue()}
			onSend={async () => ({ ok: false, status: 500, error: { code: "internal", message: "try again" } })}
			onStop={async (id) => cancellation(id)}
		/>,
	);
	fireEvent.change(textarea, { target: { value: "keep this" } });
	fireEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "try again"));
	assert.equal(textarea.value, "keep this");

	view.rerender(
		<Composer
			queue={emptyQueue()}
			onSend={async () => ({ ok: false, status: 409, error: { code: "context_exhausted" } })}
			onStop={async (id) => cancellation(id)}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /Compact the session/));
	assert.equal(textarea.value, "keep this");
});

test("the queue removes waiting prompts but gives compactions no delete action", async () => {
	const remove = vi.fn(async (turnId: string) => cancellation(turnId));
	render(<QueueStack queue={waitingQueue()} onRemove={remove} />);
	assert.match(screen.getByText("queued prompt").textContent ?? "", /queued prompt/);
	assert.equal(screen.getByText("Automatic compaction").textContent, "Automatic compaction");
	const button = screen.getByRole("button", { name: "Remove queued prompt: queued prompt" });
	assert.equal(screen.queryAllByRole("button").length, 1);
	fireEvent.click(button);
	await waitFor(() => assert.deepEqual(remove.mock.calls, [["turn-waiting"]]));
});

test("the compact control disables while compaction is queued", async () => {
	const compact = vi.fn(async () => compactionAdmission());
	const view = render(<SessionHeader header={header()} queue={waitingQueue()} onCompact={compact} />);
	assert.equal((screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement).disabled, true);

	view.rerender(<SessionHeader header={header()} queue={emptyQueue()} onCompact={compact} />);
	const button = screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement;
	assert.equal(button.disabled, false);
	fireEvent.click(button);
	await waitFor(() => assert.equal(compact.mock.calls.length, 1));
});

test("new session creation navigates to the empty transcript", async () => {
	const listProjectSessions = vi.fn(
		async () =>
			({
				ok: true,
				status: 200,
				value: { sessions: [] },
			}) satisfies Result<Protocol.ListSessionsResponse>,
	);
	const createProjectSession = vi.fn(
		async () =>
			({
				ok: true,
				status: 201,
				value: catalogSession(),
			}) satisfies Result<Protocol.ReadableCatalogSession>,
	);
	const navigate = vi.fn<(route: string) => void>();
	render(
		<SessionsScreen
			createProjectSession={createProjectSession}
			listProjectSessions={listProjectSessions}
			navigate={navigate}
			projectId="project/one"
		/>,
	);
	await waitFor(() => assert.equal(listProjectSessions.mock.calls.length, 1));
	fireEvent.click(screen.getByRole("button", { name: "New session" }));
	await waitFor(() => assert.deepEqual(navigate.mock.calls, [["#/projects/project%2Fone/sessions/session%20one"]]));
});

function emptyQueue(): Protocol.QueueSnapshot {
	return { revision: 0, waiting: [] };
}

function runningQueue(state: "running" | "cancelling" = "running"): Protocol.QueueSnapshot {
	return {
		revision: 1,
		running: {
			id: "queue-running",
			turnId: "turn-running",
			kind: "prompt",
			messageId: "message-running",
			text: "running prompt",
			state,
			submittedAt: "2026-01-01T00:00:00.000Z",
		},
		waiting: [],
	};
}

function waitingQueue(): Protocol.QueueSnapshot {
	return {
		revision: 2,
		waiting: [
			{
				id: "queue-waiting",
				turnId: "turn-waiting",
				kind: "prompt",
				messageId: "message-waiting",
				text: "queued prompt",
				state: "waiting",
				submittedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "queue-compaction",
				turnId: "turn-compaction",
				kind: "compaction",
				source: "auto",
				state: "waiting",
				submittedAt: "2026-01-01T00:00:01.000Z",
			},
		],
	};
}

function promptAdmission(): Result<Protocol.PromptAdmission> {
	return {
		ok: true,
		status: 202,
		value: {
			status: "running",
			sessionId: "session-one",
			turnId: "turn-new",
			messageId: "message-new",
			queueItemId: "queue-new",
			queue: emptyQueue(),
		},
	};
}

function compactionAdmission(): Result<Protocol.CompactionAdmission> {
	return {
		ok: true,
		status: 202,
		value: {
			status: "running",
			sessionId: "session-one",
			turnId: "turn-compaction-new",
			queueItemId: "queue-compaction-new",
			queue: emptyQueue(),
		},
	};
}

function cancellation(turnId: string): Result<Protocol.TurnCancellationResult> {
	return { ok: true, status: 200, value: { status: "cancelled", sessionId: "session-one", turnId } };
}

function header() {
	return {
		session: {
			id: "session-one",
			cwd: "/project",
			projectRoot: "/project",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		model: { provider: "openai" as const, id: "gpt-test", contextWindow: 100_000 },
		usage: {
			contextTokens: 1_000,
			cumulative: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, total: 1_100 },
		},
		status: "idle" as const,
	};
}

function catalogSession(): Protocol.ReadableCatalogSession {
	return {
		status: "idle",
		id: "session one",
		cwd: "/project",
		projectId: "project/one",
		projectName: "Project",
		workspaceId: "workspace-one",
		nodeId: "node-one",
		title: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}
