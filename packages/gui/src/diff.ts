export interface DiffRow {
	type: "add" | "del" | "context";
	oldLine?: number;
	newLine?: number;
	text: string;
	noNewline?: true;
}

export interface ParsedPatch {
	rows: DiffRow[];
	added: number;
	removed: number;
	valid: boolean;
}

export function parsePatch(patch: string): ParsedPatch {
	const rows: DiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	let added = 0;
	let removed = 0;
	let inHunk = false;
	let valid = true;
	const lines = patch.split("\n");

	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) continue;
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (!inHunk && line === "" && index === lines.length - 1) continue;
		if (line === "\\ No newline at end of file") {
			const previous = rows.at(-1);
			if (previous) previous.noNewline = true;
			if (!previous) valid = false;
			continue;
		}
		if (!inHunk) {
			valid = false;
			continue;
		}
		if (line.startsWith("+")) {
			rows.push({ type: "add", newLine, text: line.slice(1) });
			newLine++;
			added++;
			continue;
		}
		if (line.startsWith("-")) {
			rows.push({ type: "del", oldLine, text: line.slice(1) });
			oldLine++;
			removed++;
			continue;
		}
		if (line.startsWith(" ")) {
			rows.push({ type: "context", oldLine, newLine, text: line.slice(1) });
			oldLine++;
			newLine++;
			continue;
		}
		if (line === "" && index === lines.length - 1) continue;
		valid = false;
	}

	return { rows, added, removed, valid };
}
