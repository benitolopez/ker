import { createHash } from "node:crypto";

export function projectKey(projectRoot: string): string {
	return createHash("sha256").update(projectRoot).digest("hex");
}
