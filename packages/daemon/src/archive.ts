import { createReadStream, mkdirSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Protocol from "@ker-ai/protocol";
import { Value } from "@sinclair/typebox/value";
import { Unzip, UnzipInflate, Zip, ZipDeflate } from "fflate";

export const MAX_ARCHIVE_BYTES = 2 ** 32;
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

const MANIFEST_FILE = "manifest.json";
const CHUNK_BYTES = 64 * 1024;
const CRC_TABLE = createCrcTable();

export class ArchiveTooLargeError extends Error {}

export class InvalidArchiveError extends Error {}

export class UnsupportedArchiveError extends Error {}

export interface ArchiveInput {
	manifest: Protocol.ArchiveManifest;
	documents: Array<{ file: string; body: string }>;
	logs: Array<{ file: string; path: string }>;
}

interface ManifestInput {
	exportedAt: string;
	versions: Protocol.ArchiveManifest["versions"];
	project: Protocol.ArchiveManifest["project"];
	nodes: Protocol.ArchiveNode[];
	workspaces: Protocol.ArchiveWorkspace[];
	sessions: Array<Omit<Protocol.ArchiveSession, "file"> & { path?: string }>;
	documents: Protocol.Document[];
}

export function slug(text: string, fallback: string): string {
	const cleaned = text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return cleaned || fallback;
}

export function documentFileName(title: string, id: string, taken: Set<string>): string {
	const idHex = id.toLowerCase().replace(/[^a-f0-9]/g, "");
	const base = `documents/${slug(title, "document")}`;
	const shortName = `${base}-${idHex.slice(0, 8)}.md`;
	if (!taken.has(shortName)) {
		taken.add(shortName);
		return shortName;
	}
	const fullName = `${base}-${idHex.slice(0, 32)}.md`;
	if (taken.has(fullName)) throw new Error(`Document ${id} does not have a unique archive file name`);
	taken.add(fullName);
	return fullName;
}

export function archiveFileName(projectName: string, exportedAt: string): string {
	return `${slug(projectName, "project")}-${exportedAt.slice(0, 10)}.zip`;
}

export async function buildManifest(input: ManifestInput): Promise<ArchiveInput> {
	const taken = new Set<string>();
	const documents = input.documents.map((document) => ({
		file: documentFileName(document.title, document.id, taken),
		body: document.body,
		document,
	}));
	const sessions: Protocol.ArchiveSession[] = [];
	const logs: ArchiveInput["logs"] = [];
	const logSizes: number[] = [];
	for (const item of input.sessions) {
		const { path, ...session } = item;
		const file = path ? `sessions/${item.id}/session.jsonl` : null;
		if (file && path) {
			try {
				const size = (await stat(path)).size;
				if (size >= MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError(file);
				logs.push({ file, path });
				logSizes.push(size);
			} catch (error) {
				if (error instanceof ArchiveTooLargeError) throw error;
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				sessions.push({ ...session, file: null });
				continue;
			}
		}
		sessions.push({ ...session, file });
	}
	const archiveBytes =
		documents.reduce((total, document) => total + Buffer.byteLength(document.body, "utf8"), 0) +
		logSizes.reduce((total, size) => total + size, 0);
	if (archiveBytes >= MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError("archive");
	return {
		manifest: {
			format: Protocol.ARCHIVE_FORMAT,
			exportedAt: input.exportedAt,
			versions: input.versions,
			project: input.project,
			nodes: input.nodes,
			workspaces: input.workspaces,
			sessions,
			documents: documents.map(({ file, document }) => ({
				id: document.id,
				title: document.title,
				createdAt: document.createdAt,
				updatedAt: document.updatedAt,
				file,
			})),
		},
		documents: documents.map(({ file, body }) => ({ file, body })),
		logs,
	};
}

// Entries are completed in order so manifest.json is available before any declared content.
export async function writeArchive(input: ArchiveInput, sink: (chunk: Uint8Array) => Promise<void>): Promise<void> {
	const pending: Uint8Array[] = [];
	let failure: Error | undefined;
	const zip = new Zip((error, chunk) => {
		if (error) {
			failure = error;
			return;
		}
		pending.push(chunk);
	});
	const flush = async () => {
		if (failure) throw failure;
		for (const chunk of pending.splice(0)) await sink(chunk);
	};
	const addBytes = async (name: string, bytes: Uint8Array) => {
		const entry = new ZipDeflate(name, { level: 6 });
		zip.add(entry);
		entry.push(bytes, true);
		await flush();
	};

	await addBytes(MANIFEST_FILE, Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`));
	for (const item of input.documents) await addBytes(item.file, Buffer.from(item.body, "utf8"));
	for (const item of input.logs) {
		const size = (await stat(item.path)).size;
		if (size >= MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError(item.file);
		const entry = new ZipDeflate(item.file, { level: 6 });
		zip.add(entry);
		if (size > 0) {
			for await (const chunk of createReadStream(item.path, { end: size - 1 })) {
				entry.push(chunk as Buffer);
				await flush();
			}
		}
		entry.push(new Uint8Array(0), true);
		await flush();
	}
	zip.end();
	await flush();
}

// The upload is copied once so the central directory can be checked after streaming extraction.
export async function readArchive(
	source: AsyncIterable<Uint8Array>,
	stagingDir: string,
): Promise<{ manifest: Protocol.ArchiveManifest; files: Map<string, string> }> {
	mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
	const rawPath = join(stagingDir, ".archive.zip");
	const raw = await open(rawPath, "wx", 0o600);
	const files = new Map<string, string>();
	const declared = new Set<string>();
	const discovered = new Set<string>();
	const completed = new Set<string>();
	const checksums = new Map<string, { crc: number; size: number }>();
	const writes = new Map<string, Promise<void>>();
	const handles = new Map<string, Awaited<ReturnType<typeof open>>>();
	let manifest: Protocol.ArchiveManifest | undefined;
	let entryCount = 0;
	let failure: Error | undefined;

	const fail = (error: unknown) => {
		failure ??= toInvalidArchiveError(error);
	};
	const unzip = new Unzip((file) => {
		entryCount++;
		const isManifest = entryCount === 1;
		const accepted = isManifest || (manifest !== undefined && declared.has(file.name) && !discovered.has(file.name));
		if (isManifest && file.name !== MANIFEST_FILE) {
			fail(new InvalidArchiveError("manifest.json must be the first archive entry"));
		}
		if (!isManifest && !manifest) fail(new InvalidArchiveError("manifest.json must finish before archive files"));
		if (!isManifest && !accepted) {
			fail(new InvalidArchiveError(`Archive entry ${file.name} is not declared exactly once`));
		}
		discovered.add(file.name);
		const chunks: Buffer[] = [];
		let size = 0;
		let crc = 0xffffffff;
		const destination = !isManifest && accepted ? join(stagingDir, file.name) : undefined;
		if (destination) {
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			files.set(file.name, destination);
			writes.set(
				file.name,
				open(destination, "wx", 0o600).then((handle) => {
					handles.set(file.name, handle);
				}),
			);
		}
		file.ondata = (error, data, final) => {
			if (error) {
				fail(error);
				return;
			}
			size += data.length;
			crc = updateCrc(crc, data);
			if ((isManifest || file.name.startsWith("documents/")) && size > MAX_DOCUMENT_BYTES) {
				fail(new InvalidArchiveError(`${file.name} exceeds ${MAX_DOCUMENT_BYTES} bytes`));
				return;
			}
			if (isManifest) chunks.push(Buffer.from(data));
			if (destination) {
				const bytes = Buffer.from(data);
				const previous = writes.get(file.name) ?? Promise.resolve();
				writes.set(
					file.name,
					previous.then(async () => {
						if (bytes.length > 0) await handles.get(file.name)?.write(bytes);
						if (final) await handles.get(file.name)?.close();
					}),
				);
			}
			if (!final) return;
			completed.add(file.name);
			checksums.set(file.name, { crc: ~crc >>> 0, size });
			if (!isManifest) return;
			try {
				const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
				if (!Value.Check(Protocol.ArchiveManifest, parsed)) {
					throw new InvalidArchiveError("manifest.json does not match the archive schema");
				}
				if (parsed.format !== Protocol.ARCHIVE_FORMAT) {
					throw new UnsupportedArchiveError(`Unsupported archive format ${parsed.format}`);
				}
				validateManifestReferences(parsed);
				manifest = parsed;
				for (const document of parsed.documents) addDeclaredFile(declared, document.file);
				for (const session of parsed.sessions) {
					if (session.file) addDeclaredFile(declared, session.file);
				}
			} catch (error) {
				fail(error);
			}
		};
		try {
			file.start();
		} catch (error) {
			fail(error);
		}
	});
	unzip.register(UnzipInflate);

	try {
		for await (const sourceChunk of source) {
			const chunk = Buffer.from(sourceChunk);
			await raw.write(chunk);
			for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
				unzip.push(chunk.subarray(offset, offset + CHUNK_BYTES));
				await Promise.all(writes.values());
				if (failure) throw failure;
			}
		}
		unzip.push(new Uint8Array(0), true);
		await Promise.all(writes.values());
		if (failure) throw failure;
		if (!manifest) throw new InvalidArchiveError("Archive has no manifest.json");
		for (const name of declared) {
			if (!completed.has(name)) throw new InvalidArchiveError(`Archive is missing ${name}`);
		}
		await raw.close();
		await verifyCentralDirectory(rawPath, checksums);
		return { manifest, files };
	} catch (error) {
		await Promise.allSettled(writes.values());
		await Promise.allSettled([...handles.values()].map((handle) => handle.close()));
		await raw.close().catch(() => undefined);
		if (error instanceof UnsupportedArchiveError) throw error;
		throw toInvalidArchiveError(error);
	}
}

function validateManifestReferences(manifest: Protocol.ArchiveManifest): void {
	const workspaceIds = new Set(manifest.workspaces.map((workspace) => workspace.id));
	for (const session of manifest.sessions) {
		if (session.file !== null && session.file !== `sessions/${session.id}/session.jsonl`) {
			throw new InvalidArchiveError(`Session ${session.id} does not own ${session.file}`);
		}
		if (session.status === "unreadable") continue;
		if (session.workspaceId === null || !workspaceIds.has(session.workspaceId)) {
			throw new InvalidArchiveError(`Readable session ${session.id} has no declared workspace`);
		}
	}
}

function addDeclaredFile(declared: Set<string>, name: string): void {
	if (declared.has(name)) throw new InvalidArchiveError(`Archive declares ${name} more than once`);
	declared.add(name);
}

async function verifyCentralDirectory(
	path: string,
	checksums: Map<string, { crc: number; size: number }>,
): Promise<void> {
	const handle = await open(path, "r");
	try {
		const fileSize = (await handle.stat()).size;
		const tailSize = Math.min(fileSize, 65_557);
		const tail = Buffer.alloc(tailSize);
		await handle.read(tail, 0, tail.length, fileSize - tailSize);
		const relativeEnd = findEndOfCentralDirectory(tail);
		if (relativeEnd === -1) throw new InvalidArchiveError("Archive has no zip central directory");
		const commentLength = tail.readUInt16LE(relativeEnd + 20);
		if (relativeEnd + 22 + commentLength !== tail.length) {
			throw new InvalidArchiveError("Archive central directory is truncated");
		}
		const entries = tail.readUInt16LE(relativeEnd + 10);
		const centralSize = tail.readUInt32LE(relativeEnd + 12);
		const centralOffset = tail.readUInt32LE(relativeEnd + 16);
		const absoluteEnd = fileSize - tailSize + relativeEnd;
		if (centralOffset + centralSize !== absoluteEnd) {
			throw new InvalidArchiveError("Archive central directory has invalid bounds");
		}
		const centralChecksums = new Map<string, { crc: number; size: number }>();
		let offset = centralOffset;
		for (let index = 0; index < entries; index++) {
			const header = Buffer.alloc(46);
			const read = await handle.read(header, 0, header.length, offset);
			if (read.bytesRead !== header.length || header.readUInt32LE(0) !== 0x02014b50) {
				throw new InvalidArchiveError("Archive central directory entry is malformed");
			}
			const nameLength = header.readUInt16LE(28);
			const extraLength = header.readUInt16LE(30);
			const entryCommentLength = header.readUInt16LE(32);
			const nameBytes = Buffer.alloc(nameLength);
			if ((await handle.read(nameBytes, 0, nameLength, offset + 46)).bytesRead !== nameLength) {
				throw new InvalidArchiveError("Archive central directory name is truncated");
			}
			const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
			if (centralChecksums.has(name)) throw new InvalidArchiveError(`Archive contains duplicate ${name}`);
			centralChecksums.set(name, { crc: header.readUInt32LE(16), size: header.readUInt32LE(24) });
			offset += 46 + nameLength + extraLength + entryCommentLength;
		}
		if (offset !== centralOffset + centralSize || centralChecksums.size !== checksums.size) {
			throw new InvalidArchiveError("Archive entries do not match the central directory");
		}
		for (const [name, actual] of checksums) {
			const expected = centralChecksums.get(name);
			if (!expected || expected.crc !== actual.crc || expected.size !== actual.size) {
				throw new InvalidArchiveError(`Archive checksum failed for ${name}`);
			}
		}
	} finally {
		await handle.close();
	}
}

function findEndOfCentralDirectory(bytes: Buffer): number {
	for (let index = bytes.length - 22; index >= 0; index--) {
		if (bytes.readUInt32LE(index) === 0x06054b50) return index;
	}
	return -1;
}

function createCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
}

function updateCrc(crc: number, bytes: Uint8Array): number {
	let next = crc;
	for (const byte of bytes) next = CRC_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
	return next >>> 0;
}

function toInvalidArchiveError(error: unknown): Error {
	if (error instanceof UnsupportedArchiveError || error instanceof InvalidArchiveError) return error;
	if (error instanceof Error && "code" in error && typeof error.code === "string") return error;
	return new InvalidArchiveError(error instanceof Error ? error.message : String(error));
}
