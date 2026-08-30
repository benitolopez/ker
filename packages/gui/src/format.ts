export function formatDate(value: string | null | undefined): string {
	if (!value) return "No activity";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

export function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}
