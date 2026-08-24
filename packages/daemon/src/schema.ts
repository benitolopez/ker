import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const session = sqliteTable("session", {
	id: text().primaryKey(),
	project_key: text().notNull(),
	project_root: text(),
	cwd: text(),
	title: text(),
	status: text({ enum: ["idle", "busy", "unreadable"] }).notNull(),
	error: text(),
	created_at: text(),
	updated_at: text(),
});

export const CATALOG_VERSION = 1;

// Hand-maintained DDL mirrors the table above; the round-trip test guards against column drift.
export const DDL = `
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	project_key TEXT NOT NULL,
	project_root TEXT,
	cwd TEXT,
	title TEXT,
	status TEXT NOT NULL,
	error TEXT,
	created_at TEXT,
	updated_at TEXT
) STRICT;
`;
