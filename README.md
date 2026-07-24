# ker

ker is a minimal coding agent.

It's very early. Right now ker runs a complete coding-agent loop behind a local daemon: you send
it a prompt, the model can read and change files or run shell commands, and the loop continues
until the model returns its final answer.

## Contributions

ker is currently a personal project under active development, and I'm not accepting
contributions yet. I'd like to establish its direction and bring it to a more stable
state first. I plan to open it to contributions in some form when it's ready.

Thank you for your interest and understanding.

## What works today

- A long-lived **daemon** that holds the conversation, and a thin `ker` client that talks to
  it over HTTP.
- A streaming tool-call loop using the OpenAI Responses API, with its own retry/backoff on
  transient failures before provider output starts.
- Four built-in tools: `read`, `write`, `edit`, and `bash`.
- Durable sessions stored outside the repository. Restarting the daemon restores completed history,
  interrupted turns, and waiting work.
- Multiple sessions per project, each with its own FIFO queue. One turn runs at a time in a session,
  while different sessions can run concurrently.
- Session-owned cancellation that every monitoring client can observe. Waiting turns cancel
  immediately; running turns stay visibly `cancelling` until abort cleanup finishes.
- Session snapshots and cursor-based event catch-up for monitoring during a response or reconnecting
  after a client disconnects.
- OpenAI API-key authentication and an optional ChatGPT OAuth login. A session stays bound
  to the credential identity that started it.
- Bounded tool output: `read` pages large files, and `bash` keeps a bounded tail while spilling
  the full stream to a private temporary file.

Not there yet: a TUI, queue editing, or any provider other than OpenAI.

## Requirements

- Node 24
- An OpenAI API key, or a ChatGPT Plus/Pro subscription

## Setup

```sh
npm install
npm run build
```

## Authentication

ker needs either an OpenAI API key or a ChatGPT Plus/Pro subscription.

**API key.** Put a config file at `~/.config/ker/config.json`:

```json
{
  "apiKey": "sk-...",
  "model": "gpt-5.4-mini"
}
```

Or set `OPENAI_API_KEY` in the environment. `model` is optional and defaults to `gpt-5.4-mini`;
`reasoningEffort` is optional and accepts `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`.

**ChatGPT subscription.** Sign in with your OpenAI account instead of a key:

```sh
npx ker login
```

It opens the browser to authorize ker — on a remote box, paste the code (or the redirect URL)
back into the terminal instead. The credential is stored at `~/.config/ker/auth.json` (mode
0600), and turns then run through your subscription rather than a metered key. This uses
OpenAI's Codex login flow; it is not an officially supported third-party integration, so the
API key stays the sanctioned path.

Forget the subscription login with:

```sh
npx ker logout
```

When both are configured the subscription wins; `ker logout` reverts to the key. The daemon reads
the stored login before every provider request, so login, refresh, and logout do not require a daemon
restart. An existing session refuses a different OAuth account or a switch between OAuth and an API
key; use `ker new` to create an empty session with a new credential binding. Use `--json` when sending
a prompt to inspect the session snapshot and raw event envelopes.

## Usage

Run these from the repo root. Start the daemon in one terminal (it listens on `127.0.0.1:5537`):

```sh
npx ker daemon
```

Create a session and save its printed ID in a shell variable:

```sh
SESSION_ID="$(npx ker new)"
echo "$SESSION_ID"
```

To find an existing session ID later, run `npx ker sessions`; the ID is the first column. Send
prompts to the selected session with:

```sh
npx ker --session "$SESSION_ID" "my name is Beni"
npx ker --session "$SESSION_ID" "what's my name?"
```

List this project's sessions or monitor one. Monitor renders the current conversation state in turn
order, then follows new turns. Assistant text is the only monitor output written to stdout. Delivered,
running, and waiting prompts are prefixed with `> ` on stderr; developer notices, lifecycle status,
and errors are prefixed with `ker: ` there. Tool calls, tool results, reasoning, usage, retries, and
authentication events stay omitted from human output. Historical status banners are suppressed, but
current and future cancellation or failure transitions remain visible. Ctrl-C only stops the monitor
and never cancels work. An idle monitor prints `ker: waiting for turns` to stderr and continues
following:

```sh
npx ker sessions
npx ker monitor "$SESSION_ID"
```

`npx ker --json monitor "$SESSION_ID"` keeps the diagnostic wire view unchanged: it prints the initial
`SessionSnapshot`, raw event envelopes, and another snapshot line whenever the event cursor requires a
resync. The event tail is bounded, so this feed does not promise a complete historical replay.

Cancel the exact running or cancelling turn captured from one session:

```sh
npx ker cancel "$SESSION_ID"
npx ker --json cancel "$SESSION_ID"
```

The command captures the running turn ID from that session's snapshot before sending the request, so
a race never retargets its successor. A missing or unreadable session, an idle session, or a target
that finished during that race exits 1 without taking action.

Prompts submitted while that session is active wait as separate turns in FIFO order. There is no
steering or turn placement; every prompt creates one turn.

A prompt client waits until its turn finishes. Disconnecting it leaves the turn intact; Ctrl-C
cancels its exact waiting or running turn and exits 130. Cancellation from another local client also
makes the owning prompt command exit 130. Successful turns exit 0, while other failures exit 1.
Assistant text goes to stdout; queue and lifecycle status and errors go to stderr. Prompt commands do
not echo prompt attribution. `--json` prints the full snapshot followed by raw event envelopes:

```sh
npx ker --json --session "$SESSION_ID" "inspect the raw stream"
```

Sessions are stored under `KER_SESSION_DIR` when set. Otherwise ker uses the platform user-data
directory, grouped by canonical Git root and session ID. Protocol v7 uses session-local queue
snapshots, and session logs use record format v2. Older v1 logs are reported as unreadable and left
byte-for-byte unchanged until manually removed.

Concurrent sessions intentionally use their recorded working directories without worktree isolation.
Running two sessions against the same files can therefore conflict. Cooperative cancellation cannot
force-stop code that ignores its abort signal; safe force stopping remains deferred until turns run in
isolated processes.
