# Project archive format

ker project archives are zip files containing one project’s control-plane data and its canonical
session logs. Format 1 is intended for lossless backup and transfer between ker deployments; it
does not contain working-tree files.

## Layout

```text
<project-slug>-<YYYY-MM-DD>.zip
├── manifest.json
├── documents/
│   └── <title-slug>-<document-id-prefix>.md
└── sessions/
    └── <session-id>/session.jsonl
```

`manifest.json` is always the first zip entry. Document files contain only the UTF-8 Markdown body;
their title, identity, and timestamps live in the manifest. Session files contain the JSONL log
bytes verbatim, including logs for sessions that were busy or unreadable when exported.

## Manifest

The manifest is UTF-8 JSON with this top-level shape:

| Field | Meaning |
|---|---|
| `format` | Archive format number. The current and only supported value is `1`. |
| `exportedAt` | ISO timestamp recorded when export began. |
| `versions.protocol` | Protocol version used by the exporting daemon. |
| `versions.store` | Session-log store version used by the exporting daemon. |
| `versions.catalog` | Catalog schema version used by the exporting daemon. |
| `project` | The project’s `id`, `name`, and `createdAt` timestamp. |
| `nodes` | Nodes referenced by the exported workspaces. Each records `id`, `name`, and `createdAt`. |
| `workspaces` | Workspace metadata from the source deployment. |
| `sessions` | Session metadata and the path of each included log. |
| `documents` | Document metadata and the path of each Markdown body. |

Each workspace records `id`, `nodeId`, `rootPath`, nullable `gitRemote`, and `createdAt`. Source node
metadata also lets a server preserve the machine assignment during import.

Each session records `id`, the 64-character hexadecimal `projectKey`, nullable `workspaceId`,
nullable `nodeId`, nullable `cwd`, nullable `title`, `status`, nullable `error`, nullable timestamps,
and nullable `file`. `status` is `idle`, `busy`, or `unreadable`. A busy session is recovered as
aborted after import. A null `file` explicitly records that the log was missing during export; the
entry is counted as missing and is not imported unless its log already exists at the destination.

Each document records `id`, `title`, `createdAt`, `updatedAt`, and `file`. File names use a readable
title slug plus an ID prefix. The ID suffix widens when needed to keep every file name unique.

## Import semantics

Import merges by opaque ID. Existing project, document, and session rows win and are never
overwritten. Re-importing the same archive is therefore idempotent and reports those rows as
skipped.

An explicit `nodeId` query binds every imported workspace and session to that node. Without it, an
archive node is kept when the same node is enrolled in the destination; otherwise the sole enrolled
node is used. When neither rule selects a node, ker creates an unenrolled placeholder from the
archive metadata. Its sessions remain readable and exportable, and become drivable when a node with
that identity enrolls. Bundled mode always has one enrolled local node, so it adopts imported paths
as before.

A path already attached to the same project and selected node is reused. A path attached to a
different project rejects the whole import with `workspace_conflict`; catalog changes and moved logs
are rolled back.

The archive is fully staged and validated before catalog changes begin. Every entry after the
manifest must be declared exactly once by it, all declared non-null files must be present, entry
paths must match the format’s fixed document or session path, and CRC and uncompressed-size values
must match the zip directory. Failed imports remove their staging data.

After import, a source workspace path may not exist on its assigned node. Add a folder from the
project’s Sessions screen before starting a new session. Adding a subdirectory of a Git repository
records the canonical repository root. Each usable folder has its own New session action; the
project-level action still requires exactly one usable folder.

## Compatibility and limits

Import accepts only `format: 1`. The protocol, store, and catalog version fields record provenance;
they do not override the archive format decision. A future archive format must use a new integer and
older daemons will reject it as `unsupported_archive`.

- The request archive is limited to 4 GiB, checked from `Content-Length` when present and while
  streaming.
- The manifest and each document body are limited to 1 MiB uncompressed.
- Export refuses a project when any session log is 4 GiB or larger.
- `POST /projects/import` requires `Content-Type: application/zip`.
