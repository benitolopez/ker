# ker

ker is a minimal coding agent.

It's very early. Right now ker does exactly one thing end to end: you send it a prompt and it
streams back a single model reply. There are no tools yet, so it can't read or change your
code — that comes next. This repo is the skeleton the real agent gets built on.

## What works today

- A long-lived **daemon** that holds the conversation, and a thin `ker` client that talks to
  it over HTTP.
- One streaming model call per turn (OpenAI Responses API, bring your own key), with its own
  retry/backoff on transient failures.
- Conversation memory that lives in the daemon: start a turn in one terminal, continue from
  another — it remembers, because the client is disposable and the daemon isn't.

Not there yet: tools, an agent loop, saved sessions, abort, a TUI, any
provider other than OpenAI.

## Requirements

- Node 24
- An OpenAI API key

## Setup

```sh
npm install
npm run build
```

Then give it a key. Put a config file at `~/.config/ker/config.json`:

```json
{
  "apiKey": "sk-...",
  "model": "gpt-5.4-mini"
}
```

`model` is optional and defaults to `gpt-5.4-mini`.

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

Assistant text goes to stdout, token counts and errors to stderr.

Stop the daemon with Ctrl-C; restarting it clears the conversation (nothing is saved yet).
