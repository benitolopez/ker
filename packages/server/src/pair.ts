import { existsSync } from "node:fs";
import { Catalog } from "./catalog.ts";

// Reads the public URL recorded by the server and inserts a pairing code through a second SQLite connection.
export function createPairingLink(catalogPath: string): { url: string; expiresAt: string } | "local" | "missing" {
	if (!existsSync(catalogPath)) return "missing";
	const catalog = Catalog.open(catalogPath);
	try {
		const origin = catalog.getSetting("public_url");
		if (!origin) return "local";
		const { token, expiresAt } = catalog.createOneTimeToken("device");
		return { url: `${origin}/#/pair/${token}`, expiresAt };
	} finally {
		catalog.close();
	}
}
