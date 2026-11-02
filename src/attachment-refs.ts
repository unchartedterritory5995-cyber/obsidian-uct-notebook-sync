/**
 * Which of a note's links are attachments, and how a note's hash covers them.
 *
 * Resolution itself is Obsidian's (`ObsidianVaultSource.resolveLink` calls
 * `metadataCache.getFirstLinkpathDest`). This file only decides, for a link
 * Obsidian did or did not resolve, whether it is a file the server should show
 * (`file`), a file that is not in the vault (`missing`), or something that is not
 * an attachment at all (`skip`: a web address, an anchor, a note link).
 *
 * The server is the contract: api/services/journal_two/note_connectors/providers/
 * obsidian.py swaps each ref's `original` for the image, file chip or notice.
 */
import { parseLinktext } from 'obsidian';
import { sha256Hex } from './hashing';
import type { NoteAttachmentRef } from './types';

/** One link or embed as Obsidian's metadata cache records it. */
export interface RawLinkRef {
	/** The exact source text (`EmbedCache.original` / `LinkCache.original`). */
	original: string;
	/** The link path as Obsidian read it (`.link`), anchor included. */
	linkpath: string;
	embed: boolean;
}

/** A vault file a link resolved to. */
export interface ResolvedFile {
	path: string;
	extension: string;
	size: number;
	mtime: number;
}

export type RefClass =
	| { kind: 'skip' }
	| { kind: 'missing'; ref: NoteAttachmentRef }
	| { kind: 'file'; file: ResolvedFile; raw: RawLinkRef };

/**
 * A copy of the server's `_UNSENT_ATTACHMENT_EXTS` in
 * api/services/journal_two/note_connectors/providers/obsidian.py (its
 * `_ATT_IMAGE_EXTS` plus the documents, sheets, archives, audio, video and canvas
 * set). The server reads an unresolved name as a FILE only when its extension is
 * here; anything else with a dot (`Dr.Smith`, `Q3.Review`) is a note name. Keep the
 * two lists equal: `attachment-refs.test.ts` pins this one to the server's.
 */
export const ATTACHMENT_EXTS: ReadonlySet<string> = new Set(
	(
		'png jpg jpeg gif webp bmp svg heic heif tif tiff avif ' +
		'pdf doc docx xls xlsx ppt pptx odt ods odp rtf csv tsv txt json xml ' +
		'zip 7z rar gz tar ' +
		'mp3 m4a wav ogg flac aac opus ' +
		'mp4 mov m4v webm mkv avi ' +
		'canvas epub'
	).split(' '),
);

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/** The server's `_ext_of`: lowercased text after the last dot, none for a dotfile. */
function extOf(name: string): string {
	const idx = name.lastIndexOf('.');
	return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/**
 * The name an UNRESOLVED link stands for, read exactly as the server's
 * `providers/obsidian.py::_unresolved_bare_target` reads it: the FULL text when it
 * holds a `#` and its own extension is an attachment's (`my chart #1 (v2).png` is a
 * file NAME), else the link with its anchor split off (`x.png#anchor` is `x.png`).
 */
function unresolvedName(linkpath: string): string {
	const whole = linkpath.trim();
	if (whole.includes('#') && ATTACHMENT_EXTS.has(extOf(basename(whole)))) return whole;
	return parseLinktext(linkpath).path.trim();
}

export function classifyRef(raw: RawLinkRef, dest: ResolvedFile | null): RefClass {
	const linkpath = raw.linkpath.trim();
	if (!linkpath || linkpath.startsWith('#') || linkpath.startsWith('//') || SCHEME_RE.test(linkpath)) {
		return { kind: 'skip' };
	}
	if (dest !== null) {
		// a resolved note is a note link, plan A's
		return dest.extension.toLowerCase() === 'md' ? { kind: 'skip' } : { kind: 'file', file: dest, raw };
	}
	const name = unresolvedName(raw.linkpath);
	// No extension, `.md`, or a dotted name the server does not read as a file
	// (`[[Dr.Smith]]`): a note link, which the server keeps as a (pending) link.
	if (!name || !ATTACHMENT_EXTS.has(extOf(basename(name)))) return { kind: 'skip' };
	return {
		kind: 'missing',
		ref: { original: raw.original, embed: raw.embed, path: name, size: 0, sha256: null, status: 'missing' },
	};
}

const MIME: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	heic: 'image/heic',
	heif: 'image/heif',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	avif: 'image/avif',
	pdf: 'application/pdf',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	zip: 'application/zip',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	csv: 'text/csv',
	txt: 'text/plain',
	canvas: 'application/json',
};

export function mimeForExtension(ext: string): string {
	return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The note's `content_hash`. With no refs it is exactly 0.1.x's `sha256Hex(body)`,
 * so a note without attachments is never re-pushed by the upgrade. With refs it
 * also covers each ref's original, embed flag, path, status and blob hash, in a
 * canonical order, so a changed or moved attachment re-pushes the note.
 */
export function noteContentHash(body: string, refs: NoteAttachmentRef[] | null): string {
	if (refs === null || refs.length === 0) return sha256Hex(body);
	const canon = [...refs]
		.sort((a, b) =>
			a.original < b.original ? -1 : a.original > b.original ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		)
		.map((r) => [r.original, r.embed, r.path, r.status, r.sha256 ?? '']);
	return sha256Hex(body + '\u0000uct-attachments-v1\u0000' + JSON.stringify(canon));
}
