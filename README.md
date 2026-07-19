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
- Conversation memory that lives in the daemon: start a turn in one terminal, continue from
  another — it remembers, because the client is disposable and the daemon isn't.
- OpenAI API-key authentication and an optional ChatGPT OAuth login. A conversation stays bound
  to the credential identity that started it.
- Bounded tool output: `read` pages large files, and `bash` keeps a bounded tail while spilling
  the full stream to a private temporary file.

Not there yet: saved sessions, abort, a TUI, or any provider other than OpenAI.

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
restart. An existing conversation refuses a different OAuth account or a switch between OAuth and an
API key; use `ker new` to clear its history and credential binding. Use `--json` when sending a prompt
to inspect the authentication event and the rest of the raw event stream.

## Usage

Run these from the repo root. Start the daemon in one terminal (it listens on `127.0.0.1:5537`):

```sh
npx ker daemon
```

Send it a prompt from another terminal:

```sh
npx ker "my name is Beni"
npx ker "what's my name?"
```

Start a fresh in-memory conversation with:

```sh
npx ker new
```

Assistant text goes to stdout and errors go to stderr. Pass `--json` before the prompt to print
every raw event, including tool calls, tool results, reasoning summaries, authentication, and
token usage:

```sh
npx ker --json "my name is Beni"
```

Stop the daemon with Ctrl-C; restarting it clears the conversation (nothing is saved yet). `ker new`
also clears the current conversation without stopping the daemon, but only while no turn is running.
