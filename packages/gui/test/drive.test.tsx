import type { Result } from "@ker-ai/client";
import type * as Protocol from "@ker-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, assert, test, vi } from "vitest";
import { DocumentScreen } from "../src/screens/document.tsx";
import { DocumentsScreen } from "../src/screens/documents.tsx";
import { ProjectHeader } from "../src/screens/project-header.tsx";
import { ProjectsScreen } from "../src/screens/projects.tsx";
import { FoldersStrip, SessionsScreen } from "../src/screens/sessions.tsx";
import { Composer, QueueStack, SessionHeader, ToolBlock, toolLabel } from "../src/screens/transcript.tsx";

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

test("a diff tool block shows its path, counts, numbered rows, and no raw arguments", () => {
	render(
		<ToolBlock
			block={{
				kind: "tool",
				key: "tool:call-1",
				name: "edit",
				args: '{"path":"file.ts","old_string":"old","new_string":"new"}',
				result: {
					status: "ok",
					output: "Edited file.ts",
					details: {
						kind: "diff",
						path: "file.ts",
						patch: "--- file.ts\n+++ file.ts\n@@ -2 +2 @@\n-old\n+new\n",
					},
				},
			}}
		/>,
	);

	assert.match(screen.getByText("edit file.ts").textContent ?? "", /edit file\.ts/);
	assert.equal(screen.getByText("· +1 −1").textContent, "· +1 −1");
	const removed = screen.getByText("old");
	const added = screen.getByText("new");
	assert.equal(removed.textContent, "old");
	assert.equal(added.textContent, "new");
	assert.match(removed.closest("div")?.className ?? "", /bg-red/);
	assert.match(added.closest("div")?.className ?? "", /bg-emerald/);
	assert.equal(screen.queryByText(/old_string/), null);
	assert.equal(screen.queryByText("Edited file.ts"), null);
});

test("detail-less and failed tool blocks keep their raw output rendering", () => {
	render(
		<ToolBlock
			block={{
				kind: "tool",
				key: "tool:call-1",
				name: "edit",
				args: '{"path":"missing.ts"}',
				result: { status: "error", output: "ENOENT" },
			}}
		/>,
	);

	assert.equal(screen.getByText("edit missing.ts").textContent, "edit missing.ts");
	assert.equal(screen.getByText("ENOENT").textContent, "ENOENT");
	assert.equal(screen.getByText("failed").textContent, "failed");
});

test("an invalid diff falls back to its raw patch", () => {
	render(
		<ToolBlock
			block={{
				kind: "tool",
				key: "tool:call-1",
				name: "write",
				args: '{"path":"file.ts","content":"new"}',
				result: {
					status: "ok",
					output: "Wrote file.ts",
					details: { kind: "diff", path: "file.ts", patch: "not a patch" },
				},
			}}
		/>,
	);

	assert.equal(screen.getByText("not a patch").textContent, "not a patch");
	assert.equal(screen.queryByText(/· \+/), null);
	assert.equal(screen.queryByText("Wrote file.ts"), null);
});

test("tool labels use paths and commands with a bare-name fallback", () => {
	assert.equal(toolLabel("read", '{"path":"src/a.ts"}'), "read src/a.ts");
	assert.equal(toolLabel("edit", '{"path":"src/a.ts"}'), "edit src/a.ts");
	assert.equal(toolLabel("write", '{"path":"src/a.ts"}'), "write src/a.ts");
	assert.equal(toolLabel("bash", '{"command":"npm test"}'), "bash npm test");
	assert.equal(toolLabel("bash", "{"), "bash");
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
			createWorkspace={async () => ({ ok: false, status: 500, error: { code: "unused" } })}
			getProject={async () => projectResult()}
			listProjectSessions={listProjectSessions}
			listWorkspaces={async () => ({ ok: true, status: 200, value: { workspaces: [] } })}
			navigate={navigate}
			projectId="project/one"
		/>,
	);
	await waitFor(() => assert.equal(listProjectSessions.mock.calls.length, 1));
	fireEvent.click(screen.getByRole("button", { name: "New session" }));
	await waitFor(() => assert.deepEqual(navigate.mock.calls, [["#/projects/project%2Fone/sessions/session%20one"]]));
});

test("the project header loads the name and links both project sections", async () => {
	const pending = Promise.withResolvers<Result<Protocol.Project>>();
	const getProject = vi.fn((_projectId: string, _signal?: AbortSignal) => pending.promise);
	render(<ProjectHeader getProject={getProject} projectId="project/one" tab="documents" />);
	assert.equal(screen.getAllByText("project/one").length, 2);
	assert.equal(
		screen.getByRole("link", { name: "Sessions" }).getAttribute("href"),
		"#/projects/project%2Fone/sessions",
	);
	assert.equal(screen.getByRole("link", { name: "Documents" }).getAttribute("aria-current"), "page");
	assert.equal(screen.getByRole("link", { name: "Export" }).getAttribute("href"), "/projects/project%2Fone/export");

	pending.resolve(projectResult("Project One"));
	await waitFor(() => assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Project One"));
});

test("project import uploads the selected zip and links its result", async () => {
	const listProjects = vi.fn(
		async () => ({ ok: true, status: 200, value: { projects: [] } }) satisfies Result<Protocol.ListProjectsResponse>,
	);
	const importProject = vi.fn(
		async (_archive: Blob) =>
			({
				ok: true,
				status: 201,
				value: importResult(),
			}) satisfies Result<Protocol.ImportResult>,
	);
	const view = render(<ProjectsScreen importProject={importProject} listProjects={listProjects} />);
	await waitFor(() => assert.equal(listProjects.mock.calls.length, 1));
	const input = view.container.querySelector('input[type="file"]');
	assert(input instanceof HTMLInputElement);
	const archive = new File(["zip"], "ker.zip", { type: "application/zip" });
	fireEvent.change(input, { target: { files: [archive] } });
	await waitFor(() => assert.deepEqual(importProject.mock.calls, [[archive]]));
	assert.match(
		screen.getByText(/Imported Project:/).textContent ?? "",
		/2 documents, 4 sessions \(1 unreadable\), 2 skipped/,
	);
	assert.equal(
		screen.getByRole("link", { name: "Open project" }).getAttribute("href"),
		"#/projects/project%2Fone/sessions",
	);
	assert(listProjects.mock.calls.length >= 2);
});

test("project import shows workspace conflicts", async () => {
	const view = render(
		<ProjectsScreen
			importProject={async () => ({
				ok: false,
				status: 409,
				error: { code: "workspace_conflict", message: "/work/ker already belongs to project Existing" },
			})}
			listProjects={async () => ({ ok: true, status: 200, value: { projects: [] } })}
		/>,
	);
	const input = view.container.querySelector('input[type="file"]');
	assert(input instanceof HTMLInputElement);
	fireEvent.change(input, { target: { files: [new File(["zip"], "ker.zip")] } });
	await screen.findByText("/work/ker already belongs to project Existing");
});

test("folders list existing paths first and refreshes after adding one", async () => {
	const listWorkspaces = vi
		.fn<() => Promise<Result<Protocol.ListWorkspacesResponse>>>()
		.mockResolvedValueOnce({
			ok: true,
			status: 200,
			value: {
				workspaces: [workspace("missing", "/old/ker", false), workspace("existing", "/work/ker", true)],
			},
		})
		.mockResolvedValue({
			ok: true,
			status: 200,
			value: { workspaces: [workspace("existing", "/work/ker", true), workspace("new", "/clone/ker", true)] },
		});
	const createWorkspace = vi.fn(
		async (_projectId: string, input: Protocol.WorkspaceRequest) =>
			({ ok: true, status: 201, value: workspace("new", input.path, true) }) satisfies Result<Protocol.Workspace>,
	);
	render(<FoldersStrip createWorkspace={createWorkspace} listWorkspaces={listWorkspaces} projectId="project/one" />);
	await screen.findByText("/old/ker");
	assert.deepEqual(
		screen.getAllByText(/^\/(work|old)\/ker$/).map((item) => item.textContent),
		["/work/ker", "/old/ker"],
	);
	assert.equal(screen.getByText("missing").textContent, "missing");
	const input = screen.getByLabelText("Folder path") as HTMLInputElement;
	fireEvent.change(input, { target: { value: "/clone/ker" } });
	fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
	await waitFor(() => assert.deepEqual(createWorkspace.mock.calls[0], ["project/one", { path: "/clone/ker" }]));
	await screen.findByText("/clone/ker");
	assert.equal(input.value, "");
});

test("folders explain invalid paths and project conflicts", async () => {
	const cases: Array<{ error: Protocol.ErrorBody; message: string }> = [
		{
			error: { code: "invalid_workspace" },
			message: "Enter an absolute path to an existing folder.",
		},
		{
			error: { code: "workspace_conflict", message: "/work/ker already belongs to project Existing" },
			message: "/work/ker already belongs to project Existing",
		},
	];
	for (const item of cases) {
		const view = render(
			<FoldersStrip
				createWorkspace={async () => ({ ok: false, status: 409, error: item.error })}
				listWorkspaces={async () => ({ ok: true, status: 200, value: { workspaces: [] } })}
				projectId="project/one"
			/>,
		);
		const input = screen.getByLabelText("Folder path");
		fireEvent.change(input, { target: { value: "/work/ker" } });
		fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
		await screen.findByText(item.message);
		view.unmount();
	}
});

test("new session explains when no project folder exists", async () => {
	const listWorkspaces = vi.fn(
		async () =>
			({ ok: true, status: 200, value: { workspaces: [] } }) satisfies Result<Protocol.ListWorkspacesResponse>,
	);
	render(
		<SessionsScreen
			createProjectSession={async () => ({ ok: false, status: 409, error: { code: "workspace_missing" } })}
			createWorkspace={async () => ({ ok: false, status: 500, error: { code: "unused" } })}
			getProject={async () => projectResult()}
			listProjectSessions={async () => ({ ok: true, status: 200, value: { sessions: [] } })}
			listWorkspaces={listWorkspaces}
			projectId="project/one"
		/>,
	);
	await waitFor(() => assert.equal(listWorkspaces.mock.calls.length, 1));
	fireEvent.click(await screen.findByRole("button", { name: "New session" }));
	await screen.findByText("None of this project's folders exist on this node. Add one below.");
	await waitFor(() => assert.equal(listWorkspaces.mock.calls.length, 2));
});

test("the document list keeps server order and opens the new-document route", async () => {
	const listDocuments = vi.fn(
		async () =>
			({
				ok: true,
				status: 200,
				value: {
					documents: [
						documentSummary("newer", "Newer", "2026-02-01T00:00:00.000Z"),
						documentSummary("older", "Older", "2026-01-01T00:00:00.000Z"),
					],
				},
			}) satisfies Result<Protocol.ListDocumentsResponse>,
	);
	const navigate = vi.fn<(route: string) => void>();
	render(
		<DocumentsScreen
			getProject={async () => projectResult()}
			listDocuments={listDocuments}
			navigate={navigate}
			projectId="project/one"
		/>,
	);
	await waitFor(() => assert.equal(listDocuments.mock.calls.length, 1));
	assert.deepEqual(
		screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
		["Newer", "Older"],
	);
	fireEvent.click(screen.getByRole("button", { name: "New document" }));
	assert.deepEqual(navigate.mock.calls, [["#/projects/project%2Fone/documents/new"]]);
});

test("the document list renders its empty state", async () => {
	render(
		<DocumentsScreen
			getProject={async () => projectResult()}
			listDocuments={async () => ({ ok: true, status: 200, value: { documents: [] } })}
			projectId="project-one"
		/>,
	);
	await screen.findByText("No documents yet");
});

test("a document renders Markdown and supports edit, save, and cancel keys", async () => {
	const original = documentRecord({ body: "# Heading\n\n<script>alert(1)</script>" });
	const getDocument = vi.fn(async (_id: string, _signal?: AbortSignal) => documentResult(original));
	const updateDocument = vi.fn(async (_id: string, input: Protocol.DocumentRequest, _signal?: AbortSignal) =>
		documentResult({ ...original, ...input, updatedAt: "2026-02-01T00:00:00.000Z" }),
	);
	render(
		<DocumentScreen
			createDocument={async (_projectId, input) => documentResult({ ...original, ...input })}
			deleteDocument={async () => documentResult(original)}
			documentId={original.id}
			getDocument={getDocument}
			projectId={original.projectId}
			updateDocument={updateDocument}
		/>,
	);
	await screen.findByRole("heading", { level: 1, name: original.title });
	assert.equal(screen.getByRole("heading", { level: 1, name: "Heading" }).textContent, "Heading");
	assert.match(screen.getByRole("article").textContent ?? "", /<script>alert\(1\)<\/script>/);
	assert.equal(screen.getByRole("article").querySelector("script"), null);

	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	const title = screen.getByLabelText("Title") as HTMLInputElement;
	const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
	assert.equal(title.value, original.title);
	assert.equal(title.maxLength, 200);
	assert.equal(body.value, original.body);
	assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
	fireEvent.change(title, { target: { value: "   " } });
	assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
	fireEvent.change(title, { target: { value: "Updated title" } });
	fireEvent.change(body, { target: { value: "Updated body" } });
	fireEvent.keyDown(title, { key: "s", metaKey: true });
	await waitFor(() =>
		assert.deepEqual(updateDocument.mock.calls[0]?.slice(0, 2), [
			original.id,
			{
				title: "Updated title",
				body: "Updated body",
			},
		]),
	);
	await screen.findByRole("heading", { level: 1, name: "Updated title" });

	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	const editedBody = screen.getByLabelText("Body") as HTMLTextAreaElement;
	fireEvent.change(editedBody, { target: { value: "Unsaved" } });
	fireEvent.keyDown(editedBody, { key: "Escape" });
	await screen.findByText("Updated body");
	assert.equal(updateDocument.mock.calls.length, 1);
});

test("a document poll that resolves during editing keeps the draft", async () => {
	const original = documentRecord();
	const pending = Promise.withResolvers<Result<Protocol.Document>>();
	const getDocument = vi
		.fn((_id: string, _signal?: AbortSignal) => pending.promise)
		.mockResolvedValueOnce(documentResult(original));
	render(
		<DocumentScreen
			createDocument={async (_projectId, input) => documentResult({ ...original, ...input })}
			deleteDocument={async () => documentResult(original)}
			documentId={original.id}
			getDocument={getDocument}
			projectId={original.projectId}
			updateDocument={async (_id, input) => documentResult({ ...original, ...input })}
		/>,
	);
	await screen.findByRole("button", { name: "Edit" });
	window.dispatchEvent(new Event("focus"));
	await waitFor(() => assert.equal(getDocument.mock.calls.length, 2));

	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	const title = screen.getByLabelText("Title") as HTMLInputElement;
	const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
	fireEvent.change(title, { target: { value: "Draft title" } });
	fireEvent.change(body, { target: { value: "Draft body" } });
	await act(async () => {
		pending.resolve(documentResult({ ...original, title: "Remote title", body: "Remote body" }));
		await pending.promise;
	});

	assert.equal(title.value, "Draft title");
	assert.equal(body.value, "Draft body");
});

test("a new document creates on first save and navigates to its real id", async () => {
	const created = documentRecord({ id: "document/new", title: "New title", body: "New body" });
	const createDocument = vi.fn(async (_projectId: string, input: Protocol.DocumentRequest, _signal?: AbortSignal) =>
		documentResult({ ...created, ...input }),
	);
	const navigate = vi.fn<(route: string) => void>();
	render(
		<DocumentScreen
			createDocument={createDocument}
			deleteDocument={async () => documentResult(created)}
			documentId="new"
			getDocument={async () => documentResult(created)}
			navigate={navigate}
			projectId="project/one"
			updateDocument={async () => documentResult(created)}
		/>,
	);
	const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
	assert.equal(save.disabled, true);
	fireEvent.change(screen.getByLabelText("Title"), { target: { value: created.title } });
	fireEvent.change(screen.getByLabelText("Body"), { target: { value: created.body } });
	fireEvent.click(save);
	await waitFor(() =>
		assert.deepEqual(createDocument.mock.calls[0]?.slice(0, 2), [
			"project/one",
			{
				title: created.title,
				body: created.body,
			},
		]),
	);
	assert.deepEqual(navigate.mock.calls, [["#/projects/project%2Fone/documents/document%2Fnew"]]);
});

test("document deletion requires inline confirmation", async () => {
	const document = documentRecord();
	const deleteDocument = vi.fn(async (_id: string, _signal?: AbortSignal) => documentResult(document));
	const navigate = vi.fn<(route: string) => void>();
	render(
		<DocumentScreen
			createDocument={async (_projectId, input) => documentResult({ ...document, ...input })}
			deleteDocument={deleteDocument}
			documentId={document.id}
			getDocument={async () => documentResult(document)}
			navigate={navigate}
			projectId={document.projectId}
			updateDocument={async (_id, input) => documentResult({ ...document, ...input })}
		/>,
	);
	await screen.findByRole("button", { name: "Delete" });
	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	assert.equal(deleteDocument.mock.calls.length, 0);
	assert.equal(screen.getByText("Delete this document?").textContent, "Delete this document?");
	fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
	await waitFor(() => assert.deepEqual(deleteDocument.mock.calls, [[document.id]]));
	assert.deepEqual(navigate.mock.calls, [["#/projects/project-one/documents"]]);
});

test("a failed document save keeps the draft and shows the error", async () => {
	const document = documentRecord();
	render(
		<DocumentScreen
			createDocument={async (_projectId, input) => documentResult({ ...document, ...input })}
			deleteDocument={async () => documentResult(document)}
			documentId={document.id}
			getDocument={async () => documentResult(document)}
			projectId={document.projectId}
			updateDocument={async () => ({ ok: false, status: 500, error: { code: "internal", message: "try again" } })}
		/>,
	);
	await screen.findByRole("button", { name: "Edit" });
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
	fireEvent.change(body, { target: { value: "Keep this draft" } });
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "try again"));
	assert.equal(body.value, "Keep this draft");
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

function projectResult(name = "Project"): Result<Protocol.Project> {
	return {
		ok: true,
		status: 200,
		value: {
			id: "project/one",
			name,
			createdAt: "2026-01-01T00:00:00.000Z",
			sessionCount: 0,
			lastActivityAt: null,
		},
	};
}

function importResult(): Protocol.ImportResult {
	return {
		project: {
			id: "project/one",
			name: "Project",
			createdAt: "2026-01-01T00:00:00.000Z",
			sessionCount: 4,
			lastActivityAt: "2026-01-01T00:00:00.000Z",
		},
		created: true,
		workspaces: { created: 1, reused: 0 },
		documents: { imported: 2, skipped: 1 },
		sessions: { imported: 4, skipped: 1, unreadable: 1, missing: 0 },
	};
}

function workspace(id: string, rootPath: string, exists: boolean): Protocol.Workspace {
	return {
		id,
		projectId: "project/one",
		nodeId: "node-one",
		rootPath,
		gitRemote: "git@example.com:ker.git",
		createdAt: "2026-01-01T00:00:00.000Z",
		exists,
	};
}

function documentSummary(id: string, title: string, updatedAt: string): Protocol.DocumentSummary {
	return {
		id,
		title,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt,
	};
}

function documentRecord(overrides: Partial<Protocol.Document> = {}): Protocol.Document {
	return {
		id: "document-one",
		projectId: "project-one",
		title: "Document title",
		body: "Document body",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function documentResult(document: Protocol.Document): Result<Protocol.Document> {
	return { ok: true, status: 200, value: document };
}
