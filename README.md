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
- Multiple sessions per project, with one project-wide execution queue. Ordinary prompts create
  separate turns in arrival order.
- Session snapshots and cursor-based event catch-up for attaching during a response or reconnecting
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

List this project's sessions or attach to one. Attach prints saved model answers, any active partial
answer, and future model output. Ctrl-C detaches without cancelling work:

```sh
npx ker sessions
npx ker attach "$SESSION_ID"
```

Prompts submitted while work is active wait as separate turns. Use an exact running turn ID to place
separate work immediately after it, or to add input to that same turn:

```sh
npx ker --session "$SESSION_ID" --after-turn <turn-id> "do this next"
npx ker --session "$SESSION_ID" --to-turn <turn-id> "use this additional detail"
```

A prompt client waits until its turn finishes. Disconnecting it leaves the turn intact; Ctrl-C
cancels a waiting turn or aborts a running one. Assistant text goes to stdout, while queue status and
errors go to stderr. `--json` prints the full snapshot followed by raw event envelopes:

```sh
npx ker --json --session "$SESSION_ID" "inspect the raw stream"
```

Sessions are stored under `KER_SESSION_DIR` when set. Otherwise ker uses the platform user-data
directory, grouped by canonical Git root and session ID.
