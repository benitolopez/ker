import type * as Protocol from "@ker-ai/protocol";

export function identityChangeRemediation(event: Protocol.ErrorEvent): string | undefined {
	if (event.code !== "identity_changed" || !event.expected) return undefined;
	if (event.expected.kind === "oauth") {
		return "log back into that account with `ker login`, or start a new conversation with `ker new`";
	}
	return "run `ker logout` to use the API key again, or start a new conversation with `ker new`";
}
