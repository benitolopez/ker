import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	createWriteStream,
	fchmodSync,
	mkdirSync,
	openSync,
	rmSync,
	type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "./output-limits.ts";

export const MAX_SPILL_BYTES = 1024 * 1024 * 1024;

export interface OutputOptions {
	maxLines?: number;
	maxBytes?: number;
	maxSpillBytes?: number;
	pause?: () => void;
	resume?: () => void;
	stop?: () => void;
}

export interface OutputSnapshot {
	text: string;
	truncated: boolean;
	shown: number;
	total: number;
	path?: string;
}

let spillDirectory: string | undefined;
let spillCleanupRegistered = false;

// Accumulates combined process output without letting either the model preview or pending disk writes
// grow without bound. The full byte stream moves to a private file when the preview first truncates.
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxSpillBytes: number;
	private readonly pause: () => void;
	private readonly resume: () => void;
	private readonly stop: () => void;

	private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	private readonly maxRollingBytes: number;
	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private hasOpenLine = false;
	private stream: WriteStream | undefined;
	private streamDone: Promise<void> | undefined;
	private spillPath: string | undefined;
	private finishPromise: Promise<OutputSnapshot> | undefined;
	private stopped = false;
	private backpressured = false;
	private spillError: Error | undefined;
	private spillLimitReached = false;

	constructor(options: OutputOptions = {}) {
		this.maxLines = options.maxLines ?? MAX_OUTPUT_LINES;
		this.maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
		this.maxSpillBytes = options.maxSpillBytes ?? MAX_SPILL_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.pause = options.pause ?? (() => {});
		this.resume = options.resume ?? (() => {});
		this.stop = options.stop ?? (() => {});
	}

	get failure(): Error | undefined {
		return this.spillError;
	}

	get limitReached(): boolean {
		return this.spillLimitReached;
	}

	get isBackpressured(): boolean {
		return this.backpressured;
	}

	append(data: Buffer): void {
		if (this.stopped || data.length === 0) return;
		const remaining = this.maxSpillBytes - this.totalRawBytes;
		if (remaining <= 0) {
			this.reachLimit();
			return;
		}
		const accepted = data.length <= remaining ? data : data.subarray(0, remaining);
		try {
			this.appendAccepted(accepted);
			if (data.length >= remaining) this.reachLimit();
		} catch (error) {
			this.fail(error);
		}
	}

	finish(): Promise<OutputSnapshot> {
		this.finishPromise ??= this.finishOnce();
		return this.finishPromise;
	}

	private appendAccepted(data: Buffer): void {
		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));
		if (this.stream) {
			this.writeToSpill(data);
			return;
		}

		this.rawChunks.push(data);
		if (this.shouldSpill()) this.ensureSpill();
	}

	private async finishOnce(): Promise<OutputSnapshot> {
		this.stopped = true;
		try {
			this.appendDecodedText(this.decoder.decode());
			if (!this.stream && this.shouldSpill()) this.ensureSpill();
			if (this.stream && !this.stream.destroyed) this.stream.end();
			if (this.streamDone) await this.streamDone;
		} catch (error) {
			this.fail(error);
		}
		return this.snapshot();
	}

	private ensureSpill(): void {
		if (this.stream || this.spillError) return;
		const { descriptor, path } = openSpillFile();
		try {
			fchmodSync(descriptor, 0o600);
			const stream = createWriteStream(path, { fd: descriptor, autoClose: true });
			const deferred = Promise.withResolvers<void>();
			stream.on("drain", () => {
				if (!this.backpressured || this.stopped) return;
				this.backpressured = false;
				this.resume();
			});
			stream.on("error", (error) => {
				this.fail(error);
				deferred.resolve();
			});
			stream.once("finish", () => deferred.resolve());
			stream.once("close", () => deferred.resolve());
			this.spillPath = path;
			this.stream = stream;
			this.streamDone = deferred.promise;
		} catch (error) {
			closeSync(descriptor);
			throw error;
		}

		for (const chunk of this.rawChunks) this.writeToSpill(chunk);
		this.rawChunks = [];
	}

	private writeToSpill(data: Buffer): void {
		if (!this.stream || this.spillError) return;
		if (this.stream.write(data) || this.backpressured) return;
		this.backpressured = true;
		this.pause();
	}

	private reachLimit(): void {
		if (this.spillLimitReached) return;
		try {
			this.ensureSpill();
		} catch (error) {
			this.fail(error);
		}
		this.spillLimitReached = true;
		this.requestStop();
	}

	private fail(error: unknown): void {
		this.spillError ??= error instanceof Error ? error : new Error(String(error));
		this.requestStop();
	}

	private requestStop(): void {
		if (this.backpressured) {
			this.backpressured = false;
			this.resume();
		}
		if (this.stopped) return;
		this.stopped = true;
		this.stop();
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) return;
		const bytes = Buffer.byteLength(text, "utf8");
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

		let newlines = 0;
		let lastNewline = -1;
		for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
			newlines++;
			lastNewline = index;
		}
		this.completedLines += newlines;
		this.hasOpenLine = newlines === 0 || lastNewline < text.length - 1;
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf8");
		this.tailBytes = Buffer.byteLength(this.tailText, "utf8");
	}

	private shouldSpill(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines() > this.maxLines
		);
	}

	private totalLines(): number {
		return this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private snapshot(): OutputSnapshot {
		const firstNewline = this.tailText.indexOf("\n");
		const hasLineAfterFirstNewline = firstNewline >= 0 && firstNewline < this.tailText.length - 1;
		const text =
			!this.tailStartsAtLineBoundary && hasLineAfterFirstNewline
				? this.tailText.slice(firstNewline + 1)
				: this.tailText;
		const tail = truncateTail(text, { maxLines: this.maxLines, maxBytes: this.maxBytes });
		return {
			text: tail.text,
			truncated: this.shouldSpill(),
			shown: tail.shown,
			total: this.totalLines(),
			...(this.spillPath ? { path: this.spillPath } : {}),
		};
	}
}

// Keep whole lines from the end until either cap trips. Only a single trailing line may be sliced,
// and its slice starts at a UTF-8 boundary so the preview always contains valid decoded text.
export function truncateTail(
	content: string,
	options: { maxLines?: number; maxBytes?: number } = {},
): { text: string; truncated: boolean; shown: number; total: number } {
	const maxLines = options.maxLines ?? MAX_OUTPUT_LINES;
	const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const total = lines.length;
	if (total === 0) return { text: content, truncated: false, shown: 0, total: 0 };

	const kept: string[] = [];
	let bytes = 0;
	for (let index = total - 1; index >= 0; index--) {
		const size = Buffer.byteLength(lines[index], "utf8") + (kept.length > 0 ? 1 : 0);
		if (kept.length >= maxLines || bytes + size > maxBytes) break;
		kept.unshift(lines[index]);
		bytes += size;
	}

	if (kept.length === 0) {
		const buffer = Buffer.from(lines[total - 1], "utf8");
		let start = buffer.length - maxBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		return { text: buffer.subarray(start).toString("utf8"), truncated: true, shown: 1, total };
	}
	return { text: kept.join("\n"), truncated: kept.length < total, shown: kept.length, total };
}

// Retries once if the cached directory disappears before the spill file can be opened.
function openSpillFile(retryMissingDirectory = true): { descriptor: number; path: string } {
	const directory = requireSpillDirectory();
	const path = join(directory, `ker-bash-${randomUUID()}.txt`);
	try {
		return { descriptor: openSync(path, "wx", 0o600), path };
	} catch (error) {
		const staleDirectory =
			error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
		if (!retryMissingDirectory || !staleDirectory) throw error;
		if (spillDirectory === directory) spillDirectory = undefined;
		return openSpillFile(false);
	}
}

function requireSpillDirectory(): string {
	if (spillDirectory) return spillDirectory;
	const directory = join(tmpdir(), `ker-bash-${randomUUID()}`);
	mkdirSync(directory, { mode: 0o700 });
	try {
		chmodSync(directory, 0o700);
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	spillDirectory = directory;
	if (!spillCleanupRegistered) {
		spillCleanupRegistered = true;
		process.once("exit", cleanupSpillDirectory);
	}
	return directory;
}

function cleanupSpillDirectory(): void {
	if (!spillDirectory) return;
	try {
		rmSync(spillDirectory, { recursive: true, force: true });
	} catch {}
	spillDirectory = undefined;
}
