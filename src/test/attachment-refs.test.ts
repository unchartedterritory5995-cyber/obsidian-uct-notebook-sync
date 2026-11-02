import { describe, expect, it } from 'vitest';
import {
	ATTACHMENT_EXTS,
	classifyRef,
	mimeForExtension,
	noteContentHash,
	type RawLinkRef,
	type ResolvedFile,
} from '../attachment-refs';
import { sha256Hex } from '../hashing';
import type { NoteAttachmentRef } from '../types';

function raw(original: string, linkpath: string, embed = true): RawLinkRef {
	return { original, linkpath, embed };
}

function file(path: string, size = 10): ResolvedFile {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return { path, extension: dot > 0 ? name.slice(dot + 1) : '', size, mtime: 1 };
}

describe('classifyRef', () => {
	it('skips urls, anchors and note links; marks unresolved binaries missing', () => {
		expect(classifyRef(raw('![](https://x.com/a.png)', 'https://x.com/a.png'), null)).toEqual({ kind: 'skip' });
		expect(classifyRef(raw('[m](mailto:a@b.c)', 'mailto:a@b.c', false), null)).toEqual({ kind: 'skip' });
		expect(classifyRef(raw('[[#Risk]]', '#Risk', false), null)).toEqual({ kind: 'skip' });
		expect(classifyRef(raw('[x]()', '', false), null)).toEqual({ kind: 'skip' });
		// a resolved note is plan A's
		expect(classifyRef(raw('[[Plan]]', 'Plan', false), file('Plan.md'))).toEqual({ kind: 'skip' });
		// an unresolved name with no extension, or .md, is a note link
		expect(classifyRef(raw('[[Not yet]]', 'Not yet', false), null)).toEqual({ kind: 'skip' });
		expect(classifyRef(raw('[[Later.md]]', 'Later.md', false), null)).toEqual({ kind: 'skip' });
		// a dotted note name is a note link too: the server's attachment list decides
		expect(classifyRef(raw('[[Dr.Smith]]', 'Dr.Smith', false), null)).toEqual({ kind: 'skip' });

		const f = file('att/chart.png');
		const r = raw('![[chart.png|300]]', 'chart.png');
		expect(classifyRef(r, f)).toEqual({ kind: 'file', file: f, raw: r });

		expect(classifyRef(raw('![[gone.png]]', 'gone.png'), null)).toEqual({
			kind: 'missing',
			ref: { original: '![[gone.png]]', embed: true, path: 'gone.png', size: 0, sha256: null, status: 'missing' },
		});
		expect(classifyRef(raw('[r](docs/q3.pdf)', 'docs/q3.pdf', false), null)).toEqual({
			kind: 'missing',
			ref: { original: '[r](docs/q3.pdf)', embed: false, path: 'docs/q3.pdf', size: 0, sha256: null, status: 'missing' },
		});
	});

	it('an unresolved # name reads its extension like the server', () => {
		expect(classifyRef(raw('![[my chart #1 (v2).png]]', 'my chart #1 (v2).png'), null)).toEqual({
			kind: 'missing',
			ref: {
				original: '![[my chart #1 (v2).png]]', embed: true, path: 'my chart #1 (v2).png',
				size: 0, sha256: null, status: 'missing',
			},
		});
		expect(classifyRef(raw('![[x.png#anchor]]', 'x.png#anchor'), null)).toEqual({
			kind: 'missing',
			ref: { original: '![[x.png#anchor]]', embed: true, path: 'x.png', size: 0, sha256: null, status: 'missing' },
		});
		expect(classifyRef(raw('[[Note#Risk]]', 'Note#Risk', false), null)).toEqual({ kind: 'skip' });
	});

	it('an unresolved markdown link is named decoded, like the server no-list branch (I1)', () => {
		const missing = (original: string, linkpath: string) => classifyRef(raw(original, linkpath, false), null);
		expect(missing('[x](missing%20file.pdf)', 'missing%20file.pdf')).toEqual({
			kind: 'missing',
			ref: { original: '[x](missing%20file.pdf)', embed: false, path: 'missing file.pdf', size: 0, sha256: null, status: 'missing' },
		});
		// a %23 is a literal # in a NAME, decoded only after the fragment split
		expect(missing('[c](my%20chart%20%231.png)', 'my%20chart%20%231.png')).toMatchObject({ ref: { path: 'my chart #1.png' } });
		// a malformed escape keeps the raw text
		expect(missing('[b](bad%E0%A4%A.pdf)', 'bad%E0%A4%A.pdf')).toMatchObject({ ref: { path: 'bad%E0%A4%A.pdf' } });
		// a wikilink name is never decoded: `[[100%25.png]]` names `100%25.png`
		expect(classifyRef(raw('![[100%25.png]]', '100%25.png'), null)).toMatchObject({ ref: { path: '100%25.png' } });
	});

	it('an unresolved markdown link parses with markdown-link rules (M4)', () => {
		const md = (original: string, linkpath: string) => classifyRef(raw(original, linkpath), null);
		expect(md('![](x.png?raw=1)', 'x.png?raw=1')).toMatchObject({ kind: 'missing', ref: { path: 'x.png' } });
		expect(md('![](doc.pdf#page=2)', 'doc.pdf#page=2')).toMatchObject({ kind: 'missing', ref: { path: 'doc.pdf' } });
		expect(md('![](att\\x.png)', 'att\\x.png')).toMatchObject({ kind: 'missing', ref: { path: 'att/x.png' } });
		// a markdown link to a note stays a note link
		expect(md('[n](Plan?x=1)', 'Plan?x=1')).toEqual({ kind: 'skip' });
	});

	it('ATTACHMENT_EXTS is the server list', () => {
		// providers/obsidian.py::_UNSENT_ATTACHMENT_EXTS = _ATT_IMAGE_EXTS | the documents set
		const server = (
			'png jpg jpeg gif webp bmp svg heic heif tif tiff avif ' +
			'pdf doc docx xls xlsx ppt pptx odt ods odp rtf csv tsv txt json xml ' +
			'zip 7z rar gz tar ' +
			'mp3 m4a wav ogg flac aac opus ' +
			'mp4 mov m4v webm mkv avi ' +
			'canvas epub'
		).split(' ');
		expect([...ATTACHMENT_EXTS].sort()).toEqual([...server].sort());
	});
});

describe('noteContentHash', () => {
	const ref = (over: Partial<NoteAttachmentRef> = {}): NoteAttachmentRef => ({
		original: '![[a.png]]', embed: true, path: 'att/a.png', size: 3,
		sha256: 'a'.repeat(64), status: 'ok', ...over,
	});

	it('noteContentHash equals sha256Hex(body) for null and [] refs', () => {
		expect(noteContentHash('# hi', null)).toBe(sha256Hex('# hi'));
		expect(noteContentHash('# hi', [])).toBe(sha256Hex('# hi'));
	});

	it("noteContentHash changes when a ref's sha, status or path changes and not when ref order changes", () => {
		const a = ref();
		const b = ref({ original: '[[b.pdf]]', embed: false, path: 'att/b.pdf', sha256: 'b'.repeat(64) });
		const base = noteContentHash('body', [a, b]);
		expect(base).not.toBe(sha256Hex('body'));
		expect(noteContentHash('body', [b, a])).toBe(base);
		expect(noteContentHash('body', [ref({ sha256: 'c'.repeat(64) }), b])).not.toBe(base);
		expect(noteContentHash('body', [ref({ status: 'storage-limit' }), b])).not.toBe(base);
		expect(noteContentHash('body', [ref({ path: 'att/moved.png' }), b])).not.toBe(base);
		// the exact algorithm
		const canon = [[b.original, b.embed, b.path, b.status, b.sha256], [a.original, a.embed, a.path, a.status, a.sha256]]
			.sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1));
		expect(base).toBe(sha256Hex('body\u0000uct-attachments-v1\u0000' + JSON.stringify(canon)));
	});
});

describe('mimeForExtension', () => {
	it('mimeForExtension is case-insensitive', () => {
		expect(mimeForExtension('PNG')).toBe('image/png');
		expect(mimeForExtension('png')).toBe('image/png');
		expect(mimeForExtension('JpEg')).toBe('image/jpeg');
		expect(mimeForExtension('SVG')).toBe('image/svg+xml');
		expect(mimeForExtension('mov')).toBe('video/quicktime');
		expect(mimeForExtension('canvas')).toBe('application/json');
		expect(mimeForExtension('PDF')).toBe('application/pdf');
		expect(mimeForExtension('xyz')).toBe('application/octet-stream');
		expect(mimeForExtension('')).toBe('application/octet-stream');
	});
});
