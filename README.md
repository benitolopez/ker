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
- Durable sessions stored outside the repository. Restarting the daemon restores completed history
  and interrupted turns; queued prompts expire by default, or resume when `recoveryWindowMinutes`
  says they are recent enough.
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
- Transparent context compaction that summarizes older history near the model ceiling while keeping
  the complete transcript on disk. Compaction can also be requested manually.

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
`recoveryWindowMinutes` is optional and defaults to `0`: after a daemon restart, queued prompts older
than that many minutes are dropped as `expired` instead of auto-running, and `0` drops all of them.
The optional `compaction` object accepts `enabled` (default `true`), `reserveTokens` (default `16384`),
`keepRecentTokens` (default `20000`), `prune` (default `true`), and an optional `reasoningEffort`
override. Without that override, compaction inherits the session effort.

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

Start a new session with a prompt, then continue the latest session for the exact current directory:

```sh
npx ker "my name is Beni"
npx ker -c "what's my name?"
```

The first command creates the session without printing its ID. To select a session explicitly, create
one separately and pass its printed ID with `--session`:

```sh
SESSION_ID="$(npx ker new)"
npx ker --session "$SESSION_ID" "my name is Beni"
npx ker --session "$SESSION_ID" "what's my name?"
```

To find a session ID later, run `npx ker sessions`; the ID is the first column. `stats`, `cancel`,
`compact`, and `monitor` accept an optional ID and default to the latest session for the exact current
directory.

Monitor renders the current conversation state in turn order, then follows new turns. Assistant text
is the only monitor output written to stdout. Delivered, running, and waiting prompts are prefixed
with `> ` on stderr; developer notices, lifecycle status, and errors are prefixed with `ker: ` there.
Tool calls, tool results, reasoning, usage, retries, and authentication events stay omitted from
human output. Historical status banners are suppressed, but current and future cancellation or
failure transitions remain visible. Ctrl-C only stops the monitor and never cancels work. An idle
monitor prints `ker: waiting for turns` to stderr and continues following:

```sh
npx ker sessions
npx ker stats
npx ker compact
npx ker monitor
```

`compact` waits for the compaction turn and reports either the context reduction or that there was
nothing to compact. `--json` prints its admission and raw event envelopes. Automatic compaction uses
the same per-session FIFO queue, so it is visible to monitors and can be cancelled like any other
running turn.

An automatic compaction that cannot succeed — because the summary would not shrink the context, or
would land too near the threshold — is discarded rather than applied, and the next attempt waits
until the context has grown noticeably. Prompts and `stats` report that the last attempt failed, and
`compact` still runs on demand. If the context outgrows the model window with no compaction able to
rescue it, a prompt is refused with that explanation instead of failing against the provider.

`npx ker --json monitor "$SESSION_ID"` keeps the diagnostic wire view unchanged: it prints the initial
`SessionSnapshot`, raw event envelopes, and another snapshot line whenever the event cursor requires a
resync. The event tail is bounded, so this feed does not promise a complete historical replay.

Cancel the exact running or cancelling turn captured from one session:

```sh
npx ker cancel
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

Sessions are stored under `KER_SESSION_DIR` when set, otherwise at `~/.ker/sessions`, grouped by
canonical Git root and session ID. Protocol v13 uses session-local queue snapshots, and session logs
use record format v3. Older store versions are reported as unreadable and left byte-for-byte unchanged
until manually removed.

Concurrent sessions intentionally use their recorded working directories without worktree isolation.
Running two sessions against the same files can therefore conflict. Cooperative cancellation cannot
force-stop code that ignores its abort signal; safe force stopping remains deferred until turns run in
isolated processes.
