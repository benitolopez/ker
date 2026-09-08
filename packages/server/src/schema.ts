import { sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const node = sqliteTable("node", {
	id: text().primaryKey(),
	name: text().notNull(),
	created_at: text().notNull(),
	secret_hash: text(),
	enrolled_at: text(),
	revoked_at: text(),
	last_seen_at: text(),
});

export const enrollment_token = sqliteTable("enrollment_token", {
	id: text().primaryKey(),
	token_hash: text().notNull().unique(),
	created_at: text().notNull(),
	expires_at: text().notNull(),
	used_at: text(),
});

export const project = sqliteTable("project", {
	id: text().primaryKey(),
	name: text().notNull(),
	created_at: text().notNull(),
});

export const workspace = sqliteTable(
	"workspace",
	{
		id: text().primaryKey(),
		project_id: text()
			.notNull()
			.references(() => project.id),
		node_id: text()
			.notNull()
			.references(() => node.id),
		root_path: text().notNull(),
		git_remote: text(),
		created_at: text().notNull(),
	},
	(table) => [unique().on(table.node_id, table.root_path)],
);

export const session = sqliteTable("session", {
	id: text().primaryKey(),
	project_key: text().notNull(),
	cwd: text(),
	title: text(),
	status: text({ enum: ["idle", "busy", "unreadable"] }).notNull(),
	error: text(),
	created_at: text(),
	updated_at: text(),
	project_id: text().references(() => project.id),
	workspace_id: text().references(() => workspace.id),
	node_id: text().references(() => node.id),
});

export const document = sqliteTable("document", {
	id: text().primaryKey(),
	project_id: text()
		.notNull()
		.references(() => project.id),
	title: text().notNull(),
	body: text().notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
});

export const CATALOG_VERSION = 4;

export const DDL = `
CREATE TABLE node (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	secret_hash TEXT,
	enrolled_at TEXT,
	revoked_at TEXT,
	last_seen_at TEXT
) STRICT;
CREATE TABLE enrollment_token (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT
) STRICT;
CREATE TABLE project (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;
CREATE TABLE workspace (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES project(id),
	node_id TEXT NOT NULL REFERENCES node(id),
	root_path TEXT NOT NULL,
	git_remote TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (node_id, root_path)
) STRICT;
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	project_key TEXT NOT NULL,
	cwd TEXT,
	title TEXT,
	status TEXT NOT NULL,
	error TEXT,
	created_at TEXT,
	updated_at TEXT,
	project_id TEXT REFERENCES project(id),
	workspace_id TEXT REFERENCES workspace(id),
	node_id TEXT REFERENCES node(id)
) STRICT;
CREATE TABLE document (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES project(id),
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
`;

export const MIGRATIONS: Readonly<Record<number, string>> = {
	2: `
CREATE TABLE node (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;
CREATE TABLE project (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;
CREATE TABLE workspace (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES project(id),
	node_id TEXT NOT NULL REFERENCES node(id),
	root_path TEXT NOT NULL,
	git_remote TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (node_id, root_path)
) STRICT;
ALTER TABLE session ADD COLUMN project_id TEXT REFERENCES project(id);
ALTER TABLE session ADD COLUMN workspace_id TEXT REFERENCES workspace(id);
ALTER TABLE session ADD COLUMN node_id TEXT REFERENCES node(id);
ALTER TABLE session DROP COLUMN project_root;
`,
	3: `
CREATE TABLE document (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES project(id),
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
`,
	4: `
ALTER TABLE node ADD COLUMN secret_hash TEXT;
ALTER TABLE node ADD COLUMN enrolled_at TEXT;
ALTER TABLE node ADD COLUMN revoked_at TEXT;
ALTER TABLE node ADD COLUMN last_seen_at TEXT;
CREATE TABLE enrollment_token (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT
) STRICT;
`,
};
