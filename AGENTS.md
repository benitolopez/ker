# Development Rules

## Code Quality

### General Principles

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Avoid using the `any` type
- Inline single-line helpers that have only one call site.
- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.

### Comments

Three kinds of comment earn their place: what a non-obvious function does, why the code is the way it is, and the design of a tricky piece. Skip everything else.

- One comment per function, at the top. Fold the why and design into it; don't scatter them through the body.
- Keep it short and describe the hard parts plainly. If a comment takes longer to read than the code, drop it.
- No comment on self-explanatory code. If the name says it, say nothing.
- Describe the code as it is. Never reference the development process: no steps, phases, dates, or spec sections (`Day-1`, `Overview > Decided`, "for now", "later").
- Don't label comments (`WHY:`, `NOTE:`, `DESIGN:`). Just write the sentence.
- Delete dead code; don't comment it out.
- Never add `TODO`/`FIXME` unless asked, and never delete an existing one.
- Write in a plain register. Cut the tells of machine prose: editorializing adjectives (`embryonic`, `robust`, `dumb`), coined nouns dressed up as standard terms (`turn pump`), first-person `we`/`our` (`our events` → name the events), and punchy taglines (`does one thing end to end`, `outlives any client` → state the mechanism instead).

```ts
// Bad
// Day-1 substrate (Overview > Decided): events are serializable plain data
// and actor-attributed (actor ∈ {agent, human, process}).
export interface KerEvent { ... }

// Good
// Wire contract between the daemon and its clients. Events stay plain serializable
// data and carry their actor, so they survive a socket and stay attributable.
export interface KerEvent { ... }
```

```ts
// Bad
export function run() {
  const event = ...
  // The first, dumbest client (build-ramp step 1): just print the event.
  console.log(...)
}

// Good
// Print one event to stdout in actor-tagged form.
export function run() { ... }
```

```ts
// Bad — flowery adjective, first-person "our", a slogan
// The embryonic harness: streams the reply as our events, and outlives any client.

// Good — plain, mechanism stated
// Holds the conversation in memory; each send streams the reply, then records it for the next turn.
```

### Naming

Name a type for what it is; let the import path say where it's from. Don't prefix type names with the product (`Ker`) or the package/layer (`Ai`, `Protocol`) — that repeats what the module path already states.

- Disambiguate names that collide across packages with a namespace import, not a prefix.
- A discriminated union takes the plain noun (`Event`); its variants carry the discriminant as a suffix (`MessageEvent`, `UsageEvent`); a shared base interface is `EventBase`.
- Suffix a wire/stream event with `Event`; leave a plain data payload unsuffixed (`Usage` the payload vs `UsageEvent` the event that carries it).
- `import type` for identifiers used only in type positions; plain `import` for runtime values.

```ts
// Good — @ker-ai/protocol names the type for what it is
export type Event = MessageEvent | MessageDeltaEvent | UsageEvent

// Good — the consumer disambiguates via the import path, not a prefix
import * as Llm from "@ker-ai/llm"
import type * as Protocol from "@ker-ai/protocol"
async function* send(): AsyncGenerator<Protocol.Event> {
  for await (const event of Llm.stream(...)) { ... }
}

// Bad — product/layer prefixes baked into the type names
export type KerEvent = ...
export type AiEvent = ...
export interface AiMessage { ... }
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Commands

- Never run `npm run build` or `npm test` unless requested by the user.
- Never commit unless the user asks.

## Git

Multiple ker sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Commit Messages

Write like a terse human, not an AI. Say what changed and, only if it isn't obvious, why.

- Subject line: imperative, concise, describes the change. Often this is the whole message.
- Add a body only when it says something the subject doesn't. If the subject already covers it, stop there.
- Don't restate the subject in the body with more words.
- Don't explain trivial details, list every touched file, or note that unrelated things stay unaffected.
- No filler, no marketing tone, no exhaustive rationale.
- Same plain voice as code comments (see above): no editorializing adjectives, coined jargon, first-person `we`/`our`, taglines, or a tech-stack / "not X yet" closer.

```
# Bad — slogans, "our", and a stack/caveat closer
Send a prompt, stream back a reply, and remember the turn.
- @ker-ai/llm — streaming, normalized to our events + error classify
Node 24, npm workspaces, Biome + tsgo, no bundler. No tools or agent loop yet.

# Good — plain and factual
Send a prompt, get one streamed model reply. The daemon keeps the conversation
in memory, so the next prompt still has the context.
```

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
