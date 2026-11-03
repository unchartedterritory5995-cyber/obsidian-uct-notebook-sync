import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { ObsidianVaultSource } from '../vault-source';
import { classifyRef } from '../attachment-refs';
import type { NoteAttachmentRef } from '../types';

interface Loc { line: number; col: number; offset: number }
interface CacheEntry { original: string; link: string; position?: { start: Loc; end: Loc } }
interface FakeCache { embeds?: CacheEntry[]; links?: CacheEntry[] }

/** A cache entry for the `nth` (0-based) occurrence of `original` in `body`, with the
 * position real Obsidian gives (`offset` is what the plugin reads). */
function at(body: string, original: string, link: string, nth = 0): CacheEntry {
	let start = -1;
	for (let i = 0; i <= nth; i++) {
		start = body.indexOf(original, start + 1);
		if (start < 0) throw new Error(`fixture: ${original} #${nth} not in body`);
	}
	const loc = (offset: number): Loc => {
		const before = body.slice(0, offset);
		const line = before.split('\n').length - 1;
		return { line, col: offset - (before.lastIndexOf('\n') + 1), offset };
	};
	return { original, link, position: { start: loc(start), end: loc(start + original.length) } };
}

function tfile(p: string, size = 0, mtime = 1): TFile {
	const f = new TFile();
	const name = p.slice(p.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	f.path = p;
	f.name = name;
	f.extension = dot > 0 ? name.slice(dot + 1) : '';
	f.basename = dot > 0 ? name.slice(0, dot) : name;
	f.stat = { mtime, size, ctime: 0 };
	return f;
}

/** Roughly Obsidian's own lookup: a path-qualified link matches the end of a path at a
 * folder boundary, a bare one the file name; `.md` is assumed for a dot-less name. */
function obsidianLike(files: TFile[]) {
	return (linkpath: string, _source: string): TFile | null => {
		const want = linkpath.toLowerCase();
		for (const cand of [want, `${want}.md`]) {
			const hit = files.find((f) => {
				const p = f.path.toLowerCase();
				return p === cand || p.endsWith('/' + cand);
			});
			if (hit) return hit;
		}
		return null;
	};
}

function fakeApp(opts: {
	files: TFile[];
	caches: Record<string, FakeCache | null>;
	dest?: (linkpath: string, source: string) => TFile | null;
	binaries?: Record<string, ArrayBuffer>;
}) {
	const listeners = new Map<string, Set<() => void>>();
	const getFirstLinkpathDest = vi.fn(opts.dest ?? obsidianLike(opts.files));
	const offref = vi.fn((ref: { name: string; fn: () => void }) => listeners.get(ref.name)?.delete(ref.fn));
	const app = {
		vault: {
			getMarkdownFiles: () => opts.files.filter((f) => f.extension === 'md'),
			getAbstractFileByPath: (p: string) => opts.files.find((f) => f.path === p) ?? null,
			readBinary: async (f: TFile) => opts.binaries?.[f.path] ?? new ArrayBuffer(0),
		},
		metadataCache: {
			getFileCache: (f: TFile) => opts.caches[f.path] ?? null,
			getFirstLinkpathDest,
			on: (name: string, fn: () => void) => {
				if (!listeners.has(name)) listeners.set(name, new Set());
				listeners.get(name)!.add(fn);
				return { name, fn };
			},
			offref,
		},
	};
	const emit = (name: string) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(); };
	const listenerCount = (name: string) => listeners.get(name)?.size ?? 0;
	return { app: app as unknown as App, getFirstLinkpathDest, offref, emit, listenerCount };
}

const SRC = 'Daily/2026-11-01.md';

describe('ObsidianVaultSource.listRawRefs', () => {
	it('listRawRefs returns embeds and links from the cache with their exact original text', () => {
		const { app } = fakeApp({
			files: [tfile(SRC)],
			caches: {
				[SRC]: {
					embeds: [
						{ original: '![[chart.png|300]]', link: 'chart.png' },
						{ original: '![](attachments/x%20y.png)', link: 'attachments/x%20y.png' },
					],
					links: [
						{ original: '[r](file.pdf)', link: 'file.pdf' },
						{ original: '[[Other note]]', link: 'Other note' },
						{ original: '![[chart.png|300]]', link: 'chart.png' }, // a duplicate original
					],
				},
			},
		});
		const vs = new ObsidianVaultSource(app);
		expect(vs.listRawRefs(SRC)).toEqual([
			{ original: '![[chart.png|300]]', linkpath: 'chart.png', embed: true },
			{ original: '![](attachments/x%20y.png)', linkpath: 'attachments/x%20y.png', embed: true },
			{ original: '[r](file.pdf)', linkpath: 'file.pdf', embed: false },
			{ original: '[[Other note]]', linkpath: 'Other note', embed: false },
		]);
		expect(vs.listRawRefs('nope.md')).toEqual([]);
	});
});

describe('ObsidianVaultSource.listRawRefs: a link whose label is an embed (issue #2)', () => {
	// Real Obsidian 1.13.7 caches ONLY the embed for `[[q.pdf|![[img.png]]]]`: no
	// LinkCache entry at all. Given the note body, listRawRefs adds the whole link as a
	// non-embed ref, found from the embed's own cached position.
	const refsFor = (body: string, cache: FakeCache, files: TFile[] = []) => {
		const { app } = fakeApp({ files: [tfile(SRC), ...files], caches: { [SRC]: cache } });
		return new ObsidianVaultSource(app).listRawRefs(SRC, body);
	};

	it('adds the whole-link ref beside the embed ref', () => {
		const body = 'x [[q.pdf|![[img.png]]]] y\n';
		expect(refsFor(body, { embeds: [at(body, '![[img.png]]', 'img.png')] })).toEqual([
			{ original: '![[img.png]]', linkpath: 'img.png', embed: true },
			{ original: '[[q.pdf|![[img.png]]]]', linkpath: 'q.pdf', embed: false },
		]);
	});

	it('classifies the added ref: an existing pdf is a file, a missing one missing, a note skipped', () => {
		const body = 'a [[q.pdf|![[i1.png]]]]\nb [[x.pdf|![[i2.png]]]]\nc [[Plan|![[i3.png]]]]\n';
		const files = [tfile('att/q.pdf', 9), tfile('att/i1.png'), tfile('att/i2.png'), tfile('att/i3.png'), tfile('Plan.md')];
		const { app } = fakeApp({
			files: [tfile(SRC), ...files],
			caches: {
				[SRC]: {
					embeds: [at(body, '![[i1.png]]', 'i1.png'), at(body, '![[i2.png]]', 'i2.png'), at(body, '![[i3.png]]', 'i3.png')],
				},
			},
		});
		const vs = new ObsidianVaultSource(app);
		const links = vs.listRawRefs(SRC, body).filter((r) => !r.embed);
		expect(links.map((r) => r.original)).toEqual([
			'[[q.pdf|![[i1.png]]]]', '[[x.pdf|![[i2.png]]]]', '[[Plan|![[i3.png]]]]',
		]);
		const kinds = links.map((r) => classifyRef(r, vs.resolveRef(r, SRC)));
		expect(kinds[0]).toMatchObject({ kind: 'file', file: { path: 'att/q.pdf', size: 9 } });
		expect(kinds[1]).toEqual({
			kind: 'missing',
			ref: { original: '[[x.pdf|![[i2.png]]]]', embed: false, path: 'x.pdf', size: 0, sha256: null, status: 'missing' },
		});
		expect(kinds[2]).toEqual({ kind: 'skip' });
	});

	it('keeps the target as written: whitespace and an #anchor', () => {
		const body = 'x [[ q.pdf |![[img.png]]]] and [[q.pdf#page=2|![[img2.png]]]]\n';
		const refs = refsFor(body, { embeds: [at(body, '![[img.png]]', 'img.png'), at(body, '![[img2.png]]', 'img2.png')] });
		expect(refs.filter((r) => !r.embed)).toEqual([
			{ original: '[[ q.pdf |![[img.png]]]]', linkpath: ' q.pdf ', embed: false },
			{ original: '[[q.pdf#page=2|![[img2.png]]]]', linkpath: 'q.pdf#page=2', embed: false },
		]);
		const { app } = fakeApp({ files: [tfile('att/q.pdf')], caches: {} });
		const vs = new ObsidianVaultSource(app);
		for (const r of refs.filter((x) => !x.embed)) expect(vs.resolveRef(r, SRC)?.path).toBe('att/q.pdf');
	});

	it('only an alias that is EXACTLY the embed counts', () => {
		for (const body of [
			'[[a]] ![[img.png]]\n', // a plain link, then an embed
			'[[q.pdf| x ![[img.png]]]]\n', // the embed is part of a longer alias
			'[[q.pdf|![[img.png]] x]]\n', // text after the embed
			'[[q.pdf|![[img.png]]\n', // never closed
			'[[q.pdf|![[img.png]]]\n', // one `]` short
			'[[|![[img.png]]]]\n', // no target
			'[[  |![[img.png]]]]\n', // a blank target
			'[[a|b|![[img.png]]]]\n', // a `|` in the target
			'[[a]b|![[img.png]]]]\n', // a `]` in the target
			'[[a[b|![[img.png]]]]\n', // a `[` in the target
			'[[q.pdf\n|![[img.png]]]]\n', // the link runs across a line
			'[[q.pdf\n\n|![[img.png]]]]\n', // ... or a blank line
			'![[q.pdf|![[img.png]]]]\n', // an EMBED whose alias is an embed: not a link
		]) {
			expect(refsFor(body, { embeds: [at(body, '![[img.png]]', 'img.png')] }), body).toEqual([
				{ original: '![[img.png]]', linkpath: 'img.png', embed: true },
			]);
		}
	});

	it('a markdown image, or an embed the server would not split out, as the alias adds nothing (fix round 1, I1)', () => {
		// The server's `_ALIAS_EMBED_RE` splits only a `![[...]]` alias off a whole-link
		// original: sent for `![](img.png)`, the whole link would claim the text and the
		// image would be lost (a chip, or a notice for a missing target).
		for (const target of ['q.pdf', 'x.pdf']) {
			const body = `x [[${target}|![](img.png)]] y\n`;
			const { app } = fakeApp({
				files: [tfile(SRC), tfile('att/q.pdf'), tfile('att/img.png')],
				caches: { [SRC]: { embeds: [at(body, '![](img.png)', 'img.png')] } },
			});
			expect(new ObsidianVaultSource(app).listRawRefs(SRC, body), target).toEqual([
				{ original: '![](img.png)', linkpath: 'img.png', embed: true },
			]);
		}
		// a `<` in the embed: the server would split it mid-line, but the plugin is stricter on purpose (no ref, 0.2.0's behaviour)
		for (const e of ['![[a<b.png]]', '![[img.png|<x]]']) {
			const body = `x [[q.pdf|${e}]] y\n`;
			expect(refsFor(body, { embeds: [at(body, e, 'x')] }), e).toEqual([{ original: e, linkpath: 'x', embed: true }]);
		}
		// an embed with an alias of its own is still split out by the server: sent
		const sized = 'x [[q.pdf|![[img.png|300]]]] y\n';
		expect(refsFor(sized, { embeds: [at(sized, '![[img.png|300]]', 'img.png')] }).filter((r) => !r.embed)).toEqual([
			{ original: '[[q.pdf|![[img.png|300]]]]', linkpath: 'q.pdf', embed: false },
		]);
	});

	it('a target holding `<` or a lone `\\r` adds nothing: stricter than the server, never looser (fix round 1, M1)', () => {
		// The server splits both mid-line (its `<` stop needs a preceding `\n`), so this only
		// gives up a chip (0.2.0's behaviour); a lone `\r` is a line break to Obsidian's editor
		for (const body of ['x [[q<.pdf|![[img.png]]]] y\n', 'x [[q\r.pdf|![[img.png]]]] y\n']) {
			expect(refsFor(body, { embeds: [at(body, '![[img.png]]', 'img.png')] }), JSON.stringify(body)).toEqual([
				{ original: '![[img.png]]', linkpath: 'img.png', embed: true },
			]);
		}
	});

	it('reads a CRLF body and a body under frontmatter at the cached offsets (fix round 1, M4)', () => {
		const crlf = 'first\r\nx [[q.pdf|![[img.png]]]] y\r\n\r\n[[r.pdf|![[i2.png]]]]\r\n';
		expect(refsFor(crlf, { embeds: [at(crlf, '![[img.png]]', 'img.png'), at(crlf, '![[i2.png]]', 'i2.png')] })
			.filter((r) => !r.embed)).toEqual([
			{ original: '[[q.pdf|![[img.png]]]]', linkpath: 'q.pdf', embed: false },
			{ original: '[[r.pdf|![[i2.png]]]]', linkpath: 'r.pdf', embed: false },
		]);
		const fm = '---\ntitle: "[[x.pdf|"\ntags: [a]\n---\n[[q.pdf|![[img.png]]]]\n';
		expect(refsFor(fm, { embeds: [at(fm, '![[img.png]]', 'img.png')] }).filter((r) => !r.embed)).toEqual([
			{ original: '[[q.pdf|![[img.png]]]]', linkpath: 'q.pdf', embed: false },
		]);
	});

	it('finds two on one line, and the same text twice once', () => {
		const body = '[[q.pdf|![[a.png]]]] and [[r.pdf|![[b.png]]]] and [[q.pdf|![[a.png]]]]\n';
		const refs = refsFor(body, {
			embeds: [at(body, '![[a.png]]', 'a.png'), at(body, '![[b.png]]', 'b.png'), at(body, '![[a.png]]', 'a.png', 1)],
		});
		expect(refs).toEqual([
			{ original: '![[a.png]]', linkpath: 'a.png', embed: true },
			{ original: '![[b.png]]', linkpath: 'b.png', embed: true },
			{ original: '[[q.pdf|![[a.png]]]]', linkpath: 'q.pdf', embed: false },
			{ original: '[[r.pdf|![[b.png]]]]', linkpath: 'r.pdf', embed: false },
		]);
	});

	it('adds nothing when Obsidian already cached a link starting at that [[', () => {
		const body = 'x [[q.pdf|![[img.png]]]] y\n';
		const cut = at(body, '[[q.pdf|![[img.png]]', 'q.pdf'); // a future cache's own shape
		expect(refsFor(body, { embeds: [at(body, '![[img.png]]', 'img.png')], links: [cut] })).toEqual([
			{ original: '![[img.png]]', linkpath: 'img.png', embed: true },
			{ original: '[[q.pdf|![[img.png]]', linkpath: 'q.pdf', embed: false },
		]);
		// a cached link elsewhere on the line does not suppress it
		const body2 = '[[b]] [[q.pdf|![[img.png]]]]\n';
		expect(refsFor(body2, { embeds: [at(body2, '![[img.png]]', 'img.png')], links: [at(body2, '[[b]]', 'b')] }))
			.toEqual([
				{ original: '![[img.png]]', linkpath: 'img.png', embed: true },
				{ original: '[[b]]', linkpath: 'b', embed: false },
				{ original: '[[q.pdf|![[img.png]]]]', linkpath: 'q.pdf', embed: false },
			]);
	});

	it('inspects nothing without a body, a position, or a position that still points at the embed', () => {
		const body = 'x [[q.pdf|![[img.png]]]] y\n';
		const embedOnly = [{ original: '![[img.png]]', linkpath: 'img.png', embed: true }];
		// no body: exactly the 0.2.0 refs
		{
			const { app } = fakeApp({ files: [tfile(SRC)], caches: { [SRC]: { embeds: [at(body, '![[img.png]]', 'img.png')] } } });
			expect(new ObsidianVaultSource(app).listRawRefs(SRC)).toEqual(embedOnly);
		}
		// an embed with no position
		expect(refsFor(body, { embeds: [{ original: '![[img.png]]', link: 'img.png' }] })).toEqual(embedOnly);
		// a cache older than the body: the offsets no longer point at the embed
		expect(refsFor('xy' + body, { embeds: [at(body, '![[img.png]]', 'img.png')] })).toEqual(embedOnly);
		// ... even where the body there still has the alias shape around other text
		const edited = 'x [[q.pdf|![[new.png]]]] y\n';
		expect(refsFor(edited, { embeds: [at(body, '![[img.png]]', 'img.png')] })).toEqual(embedOnly);
	});
});

describe('ObsidianVaultSource.resolveLink', () => {
	it('resolveLink delegates to getFirstLinkpathDest with the source path and strips #subpath', () => {
		const png = tfile('att/chart.png', 7, 5);
		const { app, getFirstLinkpathDest } = fakeApp({ files: [tfile(SRC), png], caches: {} });
		const vs = new ObsidianVaultSource(app);
		expect(vs.resolveLink('chart.png', SRC)).toEqual({ path: 'att/chart.png', extension: 'png', size: 7, mtime: 5 });
		expect(getFirstLinkpathDest).toHaveBeenLastCalledWith('chart.png', SRC);

		getFirstLinkpathDest.mockClear();
		expect(vs.resolveLink('chart.png#x', SRC)?.path).toBe('att/chart.png');
		expect(getFirstLinkpathDest.mock.calls).toEqual([['chart.png#x', SRC], ['chart.png', SRC]]);
	});

	it('resolveLink retries percent-decoded once', () => {
		const pdf = tfile('att/q3 report.pdf');
		const { app, getFirstLinkpathDest } = fakeApp({ files: [pdf], caches: {} });
		const vs = new ObsidianVaultSource(app);
		expect(vs.resolveLink('att/q3%20report.pdf', SRC)?.path).toBe('att/q3 report.pdf');
		expect(getFirstLinkpathDest.mock.calls).toEqual([['att/q3%20report.pdf', SRC], ['att/q3 report.pdf', SRC]]);
		// a malformed escape is not an exception
		getFirstLinkpathDest.mockClear();
		expect(vs.resolveLink('bad%E0%A4%A.pdf', SRC)).toBeNull();
		expect(getFirstLinkpathDest).toHaveBeenCalledTimes(1);
	});

	it('resolveLink tries the full text first when it holds #', () => {
		const png = tfile('attachments/my chart #1 (v2).png', 2048);
		const note = tfile('Note.md');
		{
			const { app, getFirstLinkpathDest } = fakeApp({ files: [png], caches: {} });
			const vs = new ObsidianVaultSource(app);
			expect(vs.resolveLink('my chart #1 (v2).png', SRC)?.path).toBe('attachments/my chart #1 (v2).png');
			expect(getFirstLinkpathDest.mock.calls[0]).toEqual(['my chart #1 (v2).png', SRC]);
		}
		{
			// only Note.md: the full text finds nothing, parseLinktext's path does
			const { app, getFirstLinkpathDest } = fakeApp({ files: [note], caches: {} });
			const vs = new ObsidianVaultSource(app);
			expect(vs.resolveLink('Note#Risk', SRC)?.path).toBe('Note.md');
			expect(getFirstLinkpathDest.mock.calls).toEqual([['Note#Risk', SRC], ['Note', SRC]]);
		}
		{
			// a resolver that answers Note.md for the full text too: not an exact name, so the split runs
			const { app, getFirstLinkpathDest } = fakeApp({ files: [note], caches: {}, dest: () => note });
			const vs = new ObsidianVaultSource(app);
			expect(vs.resolveLink('Note#Risk', SRC)?.path).toBe('Note.md');
			expect(getFirstLinkpathDest.mock.calls).toEqual([['Note#Risk', SRC], ['Note', SRC]]);
		}
		{
			// a full-text dest whose name differs is rejected and the anchor split runs
			const other = tfile('att/other.png');
			const x = tfile('att/x.png');
			const { app, getFirstLinkpathDest } = fakeApp({
				files: [other, x], caches: {},
				dest: (lp) => (lp === 'x.png#anchor' ? other : lp === 'x.png' ? x : null),
			});
			const vs = new ObsidianVaultSource(app);
			expect(vs.resolveLink('x.png#anchor', SRC)?.path).toBe('att/x.png');
			expect(getFirstLinkpathDest.mock.calls).toEqual([['x.png#anchor', SRC], ['x.png', SRC]]);
		}
		{
			// folder-qualified: the dest's path EQUALS the text, in any case
			for (const text of ['attachments/my chart #1 (v2).png', 'ATTACHMENTS/My Chart #1 (V2).PNG']) {
				const { app, getFirstLinkpathDest } = fakeApp({
					files: [png], caches: {}, dest: (lp) => (lp === text ? png : null),
				});
				const vs = new ObsidianVaultSource(app);
				expect(vs.resolveLink(text, SRC)?.path).toBe('attachments/my chart #1 (v2).png');
				expect(getFirstLinkpathDest).toHaveBeenCalledTimes(1);
			}
		}
		{
			// a path-qualified text the dest's path ends in at a folder boundary is accepted
			const deep = tfile('x/sub/my chart #1 (v2).png');
			const { app, getFirstLinkpathDest } = fakeApp({ files: [deep], caches: {}, dest: () => deep });
			const vs = new ObsidianVaultSource(app);
			expect(vs.resolveLink('sub/my chart #1 (v2).png', SRC)?.path).toBe('x/sub/my chart #1 (v2).png');
			expect(getFirstLinkpathDest).toHaveBeenCalledTimes(1);
		}
		{
			// a text the dest's name merely ends in (not at a folder boundary) is rejected
			const { app, getFirstLinkpathDest } = fakeApp({
				files: [png], caches: {}, dest: (lp) => (lp === 'y chart #1 (v2).png' ? png : null),
			});
			const vs = new ObsidianVaultSource(app);
			expect(vs.resolveLink('y chart #1 (v2).png', SRC)).toBeNull();
			expect(getFirstLinkpathDest.mock.calls).toEqual([['y chart #1 (v2).png', SRC], ['y chart', SRC]]);
		}
	});

	it('trims the link text once, for both the full-text and the split lookup (M5)', () => {
		const png = tfile('att/chart.png');
		const { app, getFirstLinkpathDest } = fakeApp({ files: [png], caches: {}, dest: () => null });
		const vs = new ObsidianVaultSource(app);
		vs.resolveLink('  chart.png  ', SRC);
		expect(getFirstLinkpathDest.mock.calls).toEqual([['chart.png', SRC]]);
		getFirstLinkpathDest.mockClear();
		vs.resolveLink(' chart.png #x ', SRC);
		expect(getFirstLinkpathDest.mock.calls).toEqual([['chart.png #x', SRC], ['chart.png', SRC]]);
	});

	it('compares names NFC-normalised in the exact-name guard (M6)', () => {
		const nfd = 'Ünïcode #1.png'.normalize('NFD');
		const nfc = 'Ünïcode #1.png'.normalize('NFC');
		expect(nfd).not.toBe(nfc);
		const png = tfile(`att/${nfd}`);
		for (const text of [nfc, `att/${nfc}`]) {
			const { app, getFirstLinkpathDest } = fakeApp({ files: [png], caches: {}, dest: (lp) => (lp === text ? png : null) });
			expect(new ObsidianVaultSource(app).resolveLink(text, SRC)?.path).toBe(`att/${nfd}`);
			expect(getFirstLinkpathDest).toHaveBeenCalledTimes(1);
		}
	});

	it('resolveRef retries a markdown destination cut at ?/# and decoded once (N1)', () => {
		const png = tfile('att/x.png');
		const pct = tfile('att/100%25.pdf');
		const { app, getFirstLinkpathDest } = fakeApp({ files: [png, pct], caches: {} });
		const vs = new ObsidianVaultSource(app);
		expect(vs.resolveRef({ original: '![](x.png?raw=1)', linkpath: 'x.png?raw=1', embed: true }, SRC)?.path)
			.toBe('att/x.png');
		expect(getFirstLinkpathDest).toHaveBeenLastCalledWith('x.png', SRC);
		// the retry name is used as is: `100%25.pdf` is never decoded a second time
		expect(vs.resolveRef({ original: '[p](100%2525.pdf?v=2)', linkpath: '100%25.pdf?v=2', embed: false }, SRC)?.path)
			.toBe('att/100%25.pdf');
		// a wikilink is never retried with markdown rules
		getFirstLinkpathDest.mockClear();
		expect(vs.resolveRef({ original: '![[x.png?raw=1]]', linkpath: 'x.png?raw=1', embed: true }, SRC)).toBeNull();
		expect(getFirstLinkpathDest.mock.calls).toEqual([['x.png?raw=1', SRC]]);
		// a hit on the first lookup needs no retry
		getFirstLinkpathDest.mockClear();
		expect(vs.resolveRef({ original: '![](x.png)', linkpath: 'x.png', embed: true }, SRC)?.path).toBe('att/x.png');
		expect(getFirstLinkpathDest).toHaveBeenCalledTimes(1);
	});

	it('returns only a TFile dest', () => {
		const { app } = fakeApp({ files: [], caches: {}, dest: () => ({ path: 'folder' }) as unknown as TFile });
		expect(new ObsidianVaultSource(app).resolveLink('folder', SRC)).toBeNull();
	});
});

describe('ObsidianVaultSource.whenMetadataReady', () => {
	it('waits for the metadata cache, then falls back to no refs', async () => {
		const a = tfile('a.md');
		const b = tfile('b.md');
		const caches: Record<string, FakeCache | null> = { 'a.md': { links: [] }, 'b.md': null };

		// every cache present: resolves at once, registers nothing
		{
			const f = fakeApp({ files: [a], caches });
			await new ObsidianVaultSource(f.app).whenMetadataReady(50);
			expect(f.listenerCount('resolved')).toBe(0);
		}
		// one null: waits for 'resolved'
		{
			const f = fakeApp({ files: [a, b], caches });
			let done = false;
			const p = new ObsidianVaultSource(f.app).whenMetadataReady(10_000).then(() => { done = true; });
			await Promise.resolve();
			expect(done).toBe(false);
			expect(f.listenerCount('resolved')).toBe(1);
			f.emit('resolved');
			await p;
			expect(done).toBe(true);
			expect(f.offref).toHaveBeenCalledTimes(1);
			expect(f.listenerCount('resolved')).toBe(0);
		}
		// one null and no event: the timeout resolves it, listener removed
		{
			const f = fakeApp({ files: [a, b], caches });
			const vs = new ObsidianVaultSource(f.app);
			await vs.whenMetadataReady(50);
			expect(f.offref).toHaveBeenCalledTimes(1);
			expect(f.listenerCount('resolved')).toBe(0);
			expect(vs.listRawRefs('b.md')).toEqual([]);
			expect(vs.isIndexed('b.md')).toBe(false);
			expect(vs.isIndexed('a.md')).toBe(true);
			expect(vs.isIndexed('nope.md')).toBe(false);
		}
	});
});

describe('ObsidianVaultSource.whenMetadataReady after indexing finished (M3)', () => {
	const a = tfile('a.md');
	const b = tfile('b.md');
	const caches: Record<string, FakeCache | null> = { 'a.md': { links: [] }, 'b.md': null };

	it('waits once, then a still-null cache no longer holds up a sync', async () => {
		const f = fakeApp({ files: [a, b], caches });
		const vs = new ObsidianVaultSource(f.app);
		await vs.whenMetadataReady(30); // no event: the first wait ends on its timeout
		const t0 = Date.now();
		await vs.whenMetadataReady(60_000); // would hang the test if it waited again
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(f.listenerCount('resolved')).toBe(0);
		expect(vs.listRawRefs('b.md')).toEqual([]);
	});

	it("after a 'resolved' event, the next sync proceeds at once", async () => {
		const f = fakeApp({ files: [a, b], caches });
		const vs = new ObsidianVaultSource(f.app);
		const p = vs.whenMetadataReady(60_000);
		f.emit('resolved');
		await p;
		await vs.whenMetadataReady(60_000);
		expect(f.listenerCount('resolved')).toBe(0);
	});
});

describe('ObsidianVaultSource.cancelWaits (final review M3)', () => {
	it('ends a pending metadata wait at once and removes its listener', async () => {
		const f = fakeApp({ files: [tfile('a.md'), tfile('b.md')], caches: { 'a.md': { links: [] }, 'b.md': null } });
		const vs = new ObsidianVaultSource(f.app);
		const t0 = Date.now();
		const p = vs.whenMetadataReady(60_000);
		await Promise.resolve();
		expect(f.listenerCount('resolved')).toBe(1);
		vs.cancelWaits();
		await p;
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(f.listenerCount('resolved')).toBe(0);
	});
});

describe('ObsidianVaultSource.readBinary', () => {
	it('reads a TFile and refuses anything else', async () => {
		const buf = new Uint8Array([1, 2, 3]).buffer;
		const { app } = fakeApp({ files: [tfile('att/a.png')], caches: {}, binaries: { 'att/a.png': buf } });
		const vs = new ObsidianVaultSource(app);
		expect(await vs.readBinary('att/a.png')).toBe(buf);
		await expect(vs.readBinary('att/none.png')).rejects.toThrow();
	});
});

// ── Server parity: the refs this plugin builds are the refs the server's fixtures pin ──
//
// The three fixtures under fixtures/server-parity/ are byte copies of the monorepo's
// api/services/journal_two/note_connectors/convert/obsidian_fixtures_in/{18,25,26}-*
// (UCT-Dashboard branch fix/obsidian-fixture-26-real-shape, 6bd900ed87, which re-pinned
// 26 to real Obsidian 1.13.7; 18 and 25 are unchanged since feat/connector-fidelity-c-server
// 9c50c686d3). Each `.vault.json` names the refs the server turns into the intended images
// and chips. The cache entries below are what Obsidian's metadataCache gives for each note
// (`original` exactly as written, `link` the link path, `position` its offsets in the
// body); `size` and `sha256` are the sidecar's own, fed in by path, since those fixtures
// carry made-up hashes. Everything else (which entries become refs, `embed`, the resolved
// `path`, the `#`-in-a-name and percent-decoded resolution, note links skipped, and the
// link-with-embed-label refs read from the body) is this plugin's.
//
// Fixture 26 (issue #2): Obsidian 1.13.7 caches ONLY the embeds for
// `[[q.pdf|![[img.png]]]]` and no link entry at all. Its cache below is embeds only; the
// q.pdf, r.pdf and s.pdf refs come from listRawRefs reading the note body.
//
// Fixture 25's sidecar also carries a ref for `![[chart.png]]`, which sits inside an
// inline code span. Obsidian's cache never reports a link in code, so production never
// sends that ref: the cache below leaves it out and NOT_FROM_OBSIDIAN drops it from the
// expectation. That ref exists to pin the SERVER's code protection, which the server's
// own tests cover (review M1).

interface Sidecar { vault_paths: string[]; self_path: string; attachments: NoteAttachmentRef[] }

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/server-parity');
/** Per fixture: its cache, built over the fixture body so every entry has its position. */
const PARITY: Record<string, (body: string) => FakeCache> = {
	'18-attachment-names': (b) => ({
		embeds: [
			at(b, '![[my chart #1 (v2).png]]', 'my chart #1 (v2).png'),
			at(b, '![](attachments/Ünïcode.png)', 'attachments/Ünïcode.png'),
		],
		links: [at(b, '[the report](attachments/q3%20report.pdf)', 'attachments/q3%20report.pdf')],
	}),
	'25-code-span-link-text': (b) => ({
		links: [
			at(b, '[`q3` deck](attachments/q.pdf)', 'attachments/q.pdf'),
			at(b, '[[q.pdf|the `q3` deck]]', 'q.pdf'),
			at(b, '[[Plan|the `x` plan]]', 'Plan'),
			at(b, '[[Plan|the `x`]]', 'Plan'),
		],
	}),
	'26-embed-as-file-alias': (b) => ({
		embeds: [
			at(b, '![[img.png]]', 'img.png'),
			at(b, '![[img2.png]]', 'img2.png'),
			at(b, '![[img3.png]]', 'img3.png'),
		],
	}),
};

const NOT_FROM_OBSIDIAN: Record<string, string[]> = { '25-code-span-link-text': ['![[chart.png]]'] };

describe('server parity fixtures', () => {
	for (const [name, cacheOf] of Object.entries(PARITY)) {
		it(`builds the refs fixture ${name} pins`, () => {
			const sidecar = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.vault.json`), 'utf8')) as Sidecar;
			const body = readFileSync(path.join(FIXTURE_DIR, `${name}.md`), 'utf8');
			const cache = cacheOf(body); // `at` throws for an original the body does not hold

			const byPath = new Map(sidecar.attachments.map((r) => [r.path, r]));
			const files = sidecar.vault_paths.map((p) => tfile(p, byPath.get(p)?.size ?? 0));
			const { app } = fakeApp({ files, caches: { [sidecar.self_path]: cache } });
			const vs = new ObsidianVaultSource(app);

			const refs: NoteAttachmentRef[] = [];
			for (const r of vs.listRawRefs(sidecar.self_path, body)) {
				const c = classifyRef(r, vs.resolveRef(r, sidecar.self_path));
				if (c.kind === 'missing') refs.push(c.ref);
				if (c.kind === 'file') {
					refs.push({
						original: c.raw.original, embed: c.raw.embed, path: c.file.path, size: c.file.size,
						sha256: byPath.get(c.file.path)?.sha256 ?? null, status: 'ok',
					});
				}
			}
			const byOriginal = (a: NoteAttachmentRef, b: NoteAttachmentRef) => (a.original < b.original ? -1 : 1);
			const skip = NOT_FROM_OBSIDIAN[name] ?? [];
			for (const o of skip) expect(sidecar.attachments.map((r) => r.original)).toContain(o);
			const expected = sidecar.attachments.filter((r) => !skip.includes(r.original));
			expect([...refs].sort(byOriginal)).toEqual(expected.sort(byOriginal));
		});
	}
});
