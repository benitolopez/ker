# Node protocol

ker nodes connect to the control plane at `ws://<server>/nodes/socket`. The node opens the
connection; the server never dials a node. The current node protocol version is `1`, the current
session-store version is `6`, and every frame is UTF-8 JSON sent as a WebSocket text frame.

The server is loopback-only in this release. Use an SSH tunnel for a node on another machine; TLS,
client authentication, and a public bind address belong to the next protocol version.

## Enrollment and authentication

`POST /nodes/enrollments` creates a random, single-use token that expires after 15 minutes. The
response includes the exact `ker node --server <url> --token <token>` command. On its first
connection, the node sends `enroll` with that token and its stable identity. The server stores only
a SHA-256 hash of the token, consumes it transactionally, creates a random per-node secret, stores
only that secret's hash, and returns the secret once in `welcome`.

The node writes the server URL and secret to `~/.ker/node.json` with mode `0600`. Later connections
send `auth` with the node ID and secret. Enrolling the same node identity again rotates its secret.
Revocation disconnects the active socket and prevents later authentication without deleting the
node's catalog rows or session logs. The bundled daemon marks its in-process node as local and
refuses to revoke it.

The first frame must be `enroll` or `auth` and must arrive within five seconds. Invalid, expired, or
spent tokens, invalid credentials, revoked nodes, and incompatible versions receive `refused` and
the socket closes.

## Handshake

```text
node                                  plane
  -- connect -------------------------->
  -- enroll | auth -------------------->
  <-- welcome { nodeId, secret? } ------
  -- hello { versions, running } ------>
  -- records ... ---------------------->  pending spool, one session at a time
  <-- ack | reject ---------------------
  -- drained -------------------------->
  <-- ready { recover } ----------------
  -- load / records / delta ... ------->
  <-- call / chunk / end / hb ... ------
```

`hello` carries `nodeProtocol`, `storeVersion`, and the IDs of turns still running in the node
process. The node drains every existing spool file before sending `drained`. The server then
registers the connection and returns busy sessions assigned to that node but absent from
`hello.running`; the node loads and recovers those sessions, then drains the spool again before
reporting itself connected. The second drain includes records appended after `drained` but before
`ready` arrived.

A second connection with the same node ID replaces the older socket.

Run only one `ker node` process against a given node identity and spool directory. Two processes
using the defaults share `~/.ker/node.json` and `~/.ker/spool`, so each new connection replaces the
other and both can race on spool files.

## Node-to-plane frames

| Frame | Fields | Meaning |
|---|---|---|
| `enroll` | `token`, `identity { id, name, createdAt }` | Exchange a one-time token for a node secret. |
| `auth` | `nodeId`, `secret` | Authenticate an enrolled node. |
| `hello` | `nodeProtocol`, `storeVersion`, `running` | Declare compatibility and in-memory running sessions. |
| `records` | `sessionId`, `records` | Send one or more chained store records from the spool. |
| `drained` | — | Declare that the startup spool has been sent. |
| `delta` | `sessionId`, `event` | Publish an ephemeral message or reasoning delta. |
| `load` | `id`, `sessionId` | Request the canonical history before executing a session. |
| `result` | `id`, `value` | Complete a plane-initiated call. |
| `error` | `id`, `code`, `message` | Fail a call with `invalid_cwd`, `unknown_session`, `turn_unavailable`, `context_exhausted`, or `internal`. |

## Plane-to-node frames

| Frame | Fields | Meaning |
|---|---|---|
| `welcome` | `nodeId`, `secret?` | Accept authentication; `secret` appears only after enrollment. |
| `refused` | `code`, `message` | Refuse with `unauthorized`, `revoked`, `token_expired`, `token_used`, or `version_mismatch`. |
| `ready` | `recover` | Finish the handshake and name sessions requiring recovery. |
| `ack` | `sessionId`, `recordId` | Confirm every record through `recordId`. |
| `reject` | `sessionId`, `recordId`, `reason: "chain"` | Reject a batch that forks the canonical chain. |
| `call` | `id`, `method`, `args` | Invoke `createSession`, `admit`, `compact`, `cancel`, `recover`, `resolveProjectRoot`, `observeGitRemote`, or `folderExists`. |
| `chunk` | `id`, `text` | Return a portion of a JSONL history load. |
| `end` | `id`, `found` | Finish a history load. |
| `hb` | — | Keep the connection live. |

Frames are runtime-validated against `@ker-ai/protocol/node`. Unknown fields or frame types close
the connection. The server limits incoming frames to 16 MiB and splits history responses into
1 MiB text chunks. A node may load, append to, or publish deltas for only sessions assigned to its
identity. A new-session batch must begin with a `session` record whose `session.id` equals the
frame's `sessionId` and whose `session.nodeId` equals the authenticated node ID.

## Store, spool, and recovery

The plane's store is canonical. Store records carry `recordId` and `previousRecordId`; the server
writes an incoming batch only when it continues the stored tail. Already-present record IDs are
idempotent, which makes reconnect replay safe. A fork receives `reject`, marks the catalog session
unreadable, drops that session's spool, and aborts its running work.

If a startup spool names a session for which the plane has neither a catalog row nor a store file,
and its first record cannot create that session, the plane sends `reject` without creating an
unreadable session. The node drops the stale spool and reconnects. A batch targeting a known session
owned by another node is an authorization failure and closes the socket instead.

The node writes each batch to `~/.ker/spool/<sessionId>.jsonl` before sending it. An `ack` removes
the acknowledged prefix and deletes the file when no records remain. If the socket disappears,
an admitted turn can continue writing to the spool. Reconnection uses exponential backoff from one
second to one minute, re-authenticates, drains the spool, and then resumes normal calls. Live deltas
are not spooled; the durable assistant record contains the final text. Usage, successful
compaction, and prune batches include a `stats` record so the plane's context estimate reflects the
latest node-side context immediately.

When a history load reconciles a non-empty spool, the node removes only the contiguous pending
prefix whose record IDs are already canonical. If the first pending record is absent from the
loaded history, the whole spool remains pending.

The server sends a WebSocket ping and `hb` every 15 seconds and terminates a node after two missed
pongs. The node closes and reconnects if it receives no frame for 45 seconds. Protocol or store
version mismatches are hard failures; there is no compatibility negotiation.

Node-initiated closes use private application codes because Node's built-in WebSocket client accepts
only `1000` or `3000`–`4999`: `4003` for a required text frame, `4008` for an invalid or refused
frame, `4011` for an internal node failure, and `4013` for a heartbeat timeout. Server-initiated
closes use the corresponding standard codes through `ws`.
