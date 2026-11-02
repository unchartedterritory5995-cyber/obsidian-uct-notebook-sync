/**
 * Phase 0 of a sync (plugin 0.2.0): find the images and files each note uses, upload
 * the blobs the server lacks, and give every note its attachment refs.
 *
 * Contract: api/routers/note_sync.py (`/obsidian/attachments/check`, `PUT
 * /obsidian/attachments/{sha256}`, `ObsidianAttachmentRef`) and
 * providers/obsidian.py, which turns each ref's `original` into the image, file chip
 * or notice.
 *
 * Nothing here fails a sync except an expired token. A server without attachment
 * support, or a check that fails, makes the run text-only exactly as 0.1.x was
 * (`null` refs: no `attachments` field, and the 0.1.x content hash).
 */
import type { Transport } from './api-client';
import { classifyRef, mimeForExtension } from './attachment-refs';
import { sha256HexBytes } from './hashing';
import type { VaultSource } from './sync-manager';
import type { AttachmentIssue, NoteAttachmentRef, PluginData } from './types';

/** How long a sync waits for Obsidian to index the vault before going on. */
export const METADATA_WAIT_MS = 15000;
/** Hashes per check request (the server takes up to 5000). */
export const CHECK_CHUNK = 1000;
/** `ObsidianAttachmentRef` bounds in note_sync.py, in code points (Python `len`). A
 * ref over them would make the server refuse the WHOLE ingest batch, so it is not
 * sent; its original stays in the note as the member wrote it. */
export const MAX_ORIGINAL_CHARS = 2048;
export const MAX_PATH_CHARS = 1024;
/** `_MAX_ATTACHMENTS_PER_NOTE`: refs past this are not sent. */
export const MAX_REFS_PER_NOTE = 5000;

export interface PrepareDeps {
	transport: Transport;
	vaultSource: VaultSource;
	data: PluginData;
	serverUrl: string;
	token: string;
}

export interface PrepareResult {
	supported: boolean;
	/** Per note: its refs, or `null` to send none (field omitted). */
	refsByNote: Map<string, NoteAttachmentRef[] | null>;
	/** Blobs uploaded this run. */
	sent: number;
	issues: AttachmentIssue[];
	authExpired: boolean;
	failMessage?: string;
}

function codePoints(s: string): number {
	return Array.from(s).length;
}

export async function prepareAttachments(deps: PrepareDeps, notePaths: string[]): Promise<PrepareResult> {
	const { transport, vaultSource, data, serverUrl, token } = deps;
	const legacy = (): PrepareResult => ({
		supported: false,
		refsByNote: new Map(notePaths.map((p) => [p, null])),
		sent: 0,
		issues: [],
		authExpired: false,
	});

	// 1. Does this server speak attachments, and what are its limits?
	const probe = await transport.checkAttachments({ serverUrl, token, sha256: [] });
	if (!probe.ok) {
		if (probe.authExpired) return { ...legacy(), authExpired: true, failMessage: probe.message };
		return legacy();
	}
	if (!probe.supported) return legacy();
	const maxBytes = probe.maxBytes;
	let remainingBytes = probe.remainingBytes;

	// 2. Obsidian's link index.
	await vaultSource.whenMetadataReady(METADATA_WAIT_MS);

	// 3. Each note's refs.
	const refsByNote = new Map<string, NoteAttachmentRef[] | null>();
	const issues: AttachmentIssue[] = [];
	const issueKeys = new Set<string>();
	const addIssue = (issue: AttachmentIssue): void => {
		const key = `${issue.reason}\u0000${issue.path}`;
		if (issueKeys.has(key)) return;
		issueKeys.add(key);
		issues.push(issue);
	};
	const hashes: PluginData['attachmentHashes'] = {};
	/** sha256 -> the first file that has it (the one uploaded). */
	const firstFile = new Map<string, { path: string; size: number; extension: string }>();

	for (const notePath of notePaths) {
		// ⛔ A note Obsidian has not indexed yet sends NO list (null), never `[]`: `[]`
		// would tell the server "this note uses no files", and its hash would match a
		// later indexed run with no refs. Its re-push with refs replaces it.
		if (!vaultSource.isIndexed(notePath)) {
			refsByNote.set(notePath, null);
			continue;
		}
		const refs: NoteAttachmentRef[] = [];
		for (const raw of vaultSource.listRawRefs(notePath)) {
			if (refs.length >= MAX_REFS_PER_NOTE) break;
			if (codePoints(raw.original) > MAX_ORIGINAL_CHARS) continue;
			const c = classifyRef(raw, vaultSource.resolveRef(raw, notePath));
			if (c.kind === 'skip') continue;
			if (c.kind === 'missing') {
				if (codePoints(c.ref.path) > MAX_PATH_CHARS) continue;
				refs.push(c.ref);
				addIssue({ path: c.ref.path, reason: 'missing', size: 0 });
				continue;
			}
			const { file } = c;
			if (codePoints(file.path) > MAX_PATH_CHARS) continue;
			const base = { original: raw.original, embed: raw.embed, path: file.path, size: file.size };
			if (!data.syncAttachments) {
				refs.push({ ...base, sha256: null, status: 'off' });
				continue;
			}
			if (file.size > maxBytes) {
				refs.push({ ...base, sha256: null, status: 'too-large' });
				addIssue({ path: file.path, reason: 'too-large', size: file.size });
				continue;
			}
			let sha = hashes[file.path]?.sha256;
			if (sha === undefined) {
				const cached = data.attachmentHashes[file.path];
				if (cached && cached.mtime === file.mtime && cached.size === file.size) {
					sha = cached.sha256;
				} else {
					try {
						sha = sha256HexBytes(await vaultSource.readBinary(file.path));
					} catch {
						// gone between the index and the read: the file is not in the vault
						refs.push({ ...base, size: 0, sha256: null, status: 'missing' });
						addIssue({ path: file.path, reason: 'missing', size: 0 });
						continue;
					}
				}
				hashes[file.path] = { mtime: file.mtime, size: file.size, sha256: sha };
			}
			refs.push({ ...base, sha256: sha, status: 'ok' });
			if (!firstFile.has(sha)) firstFile.set(sha, { path: file.path, size: file.size, extension: file.extension });
		}
		refsByNote.set(notePath, refs);
	}
	// Only paths referenced this run keep a cache entry.
	data.attachmentHashes = hashes;

	const result: PrepareResult = { supported: true, refsByNote, sent: 0, issues, authExpired: false };
	const allRefs = (): NoteAttachmentRef[] => [...refsByNote.values()].flatMap((r) => r ?? []);
	const markStorageLimit = (sha: string): void => {
		for (const r of allRefs()) {
			if (r.sha256 === sha && r.status === 'ok') {
				r.status = 'storage-limit';
				addIssue({ path: r.path, reason: 'storage-limit', size: r.size });
			}
		}
	};

	// 4. Which blobs does the server lack? Every `ok` hash of EVERY note, not only the
	// changed ones: a blob whose upload failed last run is retried although its note
	// did not change.
	const wanted = [...firstFile.keys()];
	const missing: string[] = [];
	for (let i = 0; i < wanted.length; i += CHECK_CHUNK) {
		const chunk = wanted.slice(i, i + CHECK_CHUNK);
		const out = await transport.checkAttachments({ serverUrl, token, sha256: chunk });
		if (!out.ok) {
			if (out.authExpired) return { ...result, authExpired: true, failMessage: out.message };
			// Cannot tell what is missing: upload nothing this run. The refs stay `ok`
			// (the server shows "retrying") and the next run checks again.
			return result;
		}
		if (!out.supported) return result; // switched off mid-run: the same
		missing.push(...out.missing);
		remainingBytes = out.remainingBytes;
	}

	// 5. Upload each missing blob once, in order, from the first path that has it.
	for (let i = 0; i < missing.length; i++) {
		const sha = missing[i]!;
		const f = firstFile.get(sha);
		if (!f) continue;
		if (f.size > remainingBytes) {
			markStorageLimit(sha);
			continue;
		}
		let bytes: ArrayBuffer;
		try {
			bytes = await vaultSource.readBinary(f.path);
		} catch {
			addIssue({ path: f.path, reason: 'upload-failed', size: f.size });
			continue;
		}
		const up = await transport.uploadAttachment({
			serverUrl, token, sha256: sha, name: f.path, mime: mimeForExtension(f.extension), data: bytes,
		});
		if (up.ok) {
			result.sent += 1;
			remainingBytes -= f.size;
			continue;
		}
		if (up.authExpired) return { ...result, authExpired: true, failMessage: up.message };
		if (up.retryLater) break; // the server is busy or switched off: the next sync's check retries
		if (up.storageFull) {
			for (const rest of missing.slice(i)) markStorageLimit(rest);
			break;
		}
		if (up.status === 403) {
			// The plan or the vault connection, for the whole run: one issue, no more tries.
			addIssue({ path: f.path, reason: 'upload-failed', size: f.size, message: up.message });
			break;
		}
		addIssue({ path: f.path, reason: 'upload-failed', size: f.size });
	}
	return result;
}
