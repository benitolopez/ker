import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type * as Protocol from "@ker-ai/protocol";

export interface NodeIdentity {
	id: Protocol.NodeId;
	name: string;
	createdAt: string;
}

export function loadNodeIdentity(path: string): NodeIdentity {
	try {
		return parseNodeIdentity(readFileSync(path, "utf8"), path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const identity: NodeIdentity = {
		id: randomUUID(),
		name: hostname(),
		createdAt: new Date().toISOString(),
	};
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	chmodSync(path, 0o600);
	return identity;
}

export function defaultNodePath(): string {
	return process.env.KER_NODE_PATH ?? join(homedir(), ".ker", "node.json");
}

function parseNodeIdentity(contents: string, path: string): NodeIdentity {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch {
		throw new Error(`Invalid node identity in ${path}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("id" in parsed) ||
		typeof parsed.id !== "string" ||
		parsed.id.length === 0 ||
		!("name" in parsed) ||
		typeof parsed.name !== "string" ||
		parsed.name.length === 0 ||
		!("createdAt" in parsed) ||
		typeof parsed.createdAt !== "string" ||
		Number.isNaN(Date.parse(parsed.createdAt))
	) {
		throw new Error(`Invalid node identity in ${path}`);
	}
	return { id: parsed.id, name: parsed.name, createdAt: parsed.createdAt };
}
