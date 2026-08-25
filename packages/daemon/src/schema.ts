import { sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const node = sqliteTable("node", {
	id: text().primaryKey(),
	name: text().notNull(),
	created_at: text().notNull(),
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

export const CATALOG_VERSION = 2;

export const DDL = `
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
};
