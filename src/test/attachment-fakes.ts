/**
 * Fakes for the attachment sync tests (Plan C Task 10): a vault whose notes,
 * link caches and binaries are plain maps, and a server that remembers which
 * blobs it holds, so a multi-run test sees what a real server would answer.
 */
import type {
	CheckOutcome, CheckParams, IngestOutcome, IngestParams, RedeemOutcome, Transport, UploadOutcome, UploadParams,
} from '../api-client';
import type { RawLinkRef, ResolvedFile } from '../attachment-refs';
import { sha256HexBytes } from '../hashing';
import type { VaultFileRef, VaultSource } from '../sync-manager';

export function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function shaOf(b: Uint8Array): string {
	return sha256HexBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

export function embed(name: string): RawLinkRef {
	return { original: `![[${name}]]`, linkpath: name, embed: true };
}

export class FakeVault implements VaultSource {
	notes: Record<string, string> = {};
	/** A note's cache; `null` = not indexed yet. A note with no entry is indexed with no links. */
	refs: Record<string, RawLinkRef[] | null> = {};
	files: Record<string, { data: Uint8Array; mtime: number }> = {};
	readBinaryCalls: string[] = [];
	waitCalls: number[] = [];

	note(path: string, body: string, refs: RawLinkRef[] | null = []): this {
		this.notes[path] = body;
		this.refs[path] = refs;
		return this;
	}

	file(path: string, data: Uint8Array, mtime = 1): this {
		this.files[path] = { data, mtime };
		return this;
	}

	async listMarkdownFiles(): Promise<VaultFileRef[]> {
		return Object.keys(this.notes).map((path) => ({ path, mtime: 1_700_000_000_000 }));
	}

	async readFile(path: string): Promise<string> {
		const body = this.notes[path];
		if (body === undefined) throw new Error(`no such note: ${path}`);
		return body;
	}

	async whenMetadataReady(timeoutMs: number): Promise<void> {
		this.waitCalls.push(timeoutMs);
	}

	isIndexed(notePath: string): boolean {
		return this.refs[notePath] !== null;
	}

	/** The `body` each listRawRefs call was given, by note, in call order. */
	rawRefBodies: [string, string | undefined][] = [];

	listRawRefs(notePath: string, body?: string): RawLinkRef[] {
		this.rawRefBodies.push([notePath, body]);
		return this.refs[notePath] ?? [];
	}

	/** By exact path or by file name, the way a bare wikilink resolves. */
	resolveLink(linkpath: string): ResolvedFile | null {
		const all = [...Object.keys(this.files), ...Object.keys(this.notes)];
		const hit = all.find((p) => p === linkpath || p.endsWith('/' + linkpath));
		if (hit === undefined) return null;
		const name = hit.slice(hit.lastIndexOf('/') + 1);
		const dot = name.lastIndexOf('.');
		const f = this.files[hit];
		return {
			path: hit,
			extension: dot > 0 ? name.slice(dot + 1) : '',
			size: f ? f.data.byteLength : (this.notes[hit] ?? '').length,
			mtime: f ? f.mtime : 1,
		};
	}

	resolveRef(raw: RawLinkRef): ResolvedFile | null {
		return this.resolveLink(raw.linkpath);
	}

	/** Called on every binary read, e.g. to advance a fake clock. */
	onRead: (path: string) => void = () => {};

	async readBinary(path: string): Promise<ArrayBuffer> {
		this.readBinaryCalls.push(path);
		this.onRead(path);
		const f = this.files[path];
		if (!f) throw new Error(`no such file: ${path}`);
		return f.data.slice().buffer as ArrayBuffer;
	}
}

/** A server that remembers the blobs it holds. Scripted outcomes, when queued, win. */
export class FakeServer implements Transport {
	supported = true;
	maxBytes = 26_214_400;
	/** Sent in the check answer when set (the server's per-note ref cap). */
	maxRefsPerNote: number | undefined = undefined;
	remainingBytes = 1_000_000_000;
	stored = new Set<string>();
	checkCalls: string[][] = [];
	uploadCalls: UploadParams[] = [];
	ingestCalls: IngestParams[] = [];
	/** Consumed one per call; `null` = answer normally. */
	checkScript: (CheckOutcome | null)[] = [];
	uploadScript: (UploadOutcome | null)[] = [];

	async redeem(): Promise<RedeemOutcome> {
		throw new Error('not used');
	}

	async checkAttachments(p: CheckParams): Promise<CheckOutcome> {
		this.checkCalls.push([...p.sha256]);
		const s = this.checkScript.shift();
		if (s) return s;
		if (!this.supported) return { ok: true, supported: false };
		return {
			ok: true, supported: true, missing: p.sha256.filter((h) => !this.stored.has(h)),
			maxBytes: this.maxBytes, remainingBytes: this.remainingBytes,
			...(this.maxRefsPerNote === undefined ? {} : { maxRefsPerNote: this.maxRefsPerNote }),
		};
	}

	/** Called on every upload, e.g. to advance a fake clock. */
	onUpload: () => void = () => {};

	async uploadAttachment(p: UploadParams): Promise<UploadOutcome> {
		this.uploadCalls.push(p);
		this.onUpload();
		const s = this.uploadScript.shift();
		if (s) return s;
		const stored = !this.stored.has(p.sha256);
		this.stored.add(p.sha256);
		this.remainingBytes -= p.data.byteLength;
		return { ok: true, stored };
	}

	async ingest(p: IngestParams): Promise<IngestOutcome> {
		this.ingestCalls.push(p);
		return {
			ok: true,
			response: { written: p.notes.length, skipped: 0, manifestReplaced: p.final === true, tooLarge: [] },
		};
	}

	/** Every note pushed in phase-1 calls, in order. */
	pushedNotes() {
		return this.ingestCalls.flatMap((c) => c.notes);
	}

	reset(): void {
		this.checkCalls = [];
		this.uploadCalls = [];
		this.ingestCalls = [];
	}
}

export function uploadFailure(status: number, message: string, over: Partial<{
	authExpired: boolean; storageFull: boolean; retryLater: boolean;
}> = {}): UploadOutcome {
	return { ok: false, status, message, authExpired: false, storageFull: false, retryLater: false, ...over };
}
