import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { ObsidianVaultSource } from '../vault-source';
import { classifyRef } from '../attachment-refs';
import type { NoteAttachmentRef } from '../types';

interface CacheEntry { original: string; link: string }
interface FakeCache { embeds?: CacheEntry[]; links?: CacheEntry[] }

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
// (branch feat/connector-fidelity-c-server, 9c50c686d3). Each `.vault.json` names the refs
// the server turns into the intended images and chips. The cache entries below are what
// Obsidian's metadataCache gives for each note (`original` exactly as written, `link` the
// link path); `size` and `sha256` are the sidecar's own, fed in by path, since those
// fixtures carry made-up hashes. Everything else (which entries become refs, `embed`,
// the resolved `path`, the `#`-in-a-name and percent-decoded resolution, note links
// skipped) is this plugin's.
//
// Fixture 25's sidecar also carries a ref for `![[chart.png]]`, which sits inside an
// inline code span. Obsidian's cache never reports a link in code, so production never
// sends that ref: the cache below leaves it out and NOT_FROM_OBSIDIAN drops it from the
// expectation. That ref exists to pin the SERVER's code protection, which the server's
// own tests cover (review M1).

interface Sidecar { vault_paths: string[]; self_path: string; attachments: NoteAttachmentRef[] }

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/server-parity');
const PARITY: Record<string, FakeCache> = {
	'18-attachment-names': {
		embeds: [
			{ original: '![[my chart #1 (v2).png]]', link: 'my chart #1 (v2).png' },
			{ original: '![](attachments/Ünïcode.png)', link: 'attachments/Ünïcode.png' },
		],
		links: [{ original: '[the report](attachments/q3%20report.pdf)', link: 'attachments/q3%20report.pdf' }],
	},
	'25-code-span-link-text': {
		links: [
			{ original: '[`q3` deck](attachments/q.pdf)', link: 'attachments/q.pdf' },
			{ original: '[[q.pdf|the `q3` deck]]', link: 'q.pdf' },
			{ original: '[[Plan|the `x` plan]]', link: 'Plan' },
			{ original: '[[Plan|the `x`]]', link: 'Plan' },
		],
	},
	'26-embed-as-file-alias': {
		embeds: [
			{ original: '![[img.png]]', link: 'img.png' },
			{ original: '![[img2.png]]', link: 'img2.png' },
			{ original: '![[img3.png]]', link: 'img3.png' },
		],
		links: [
			{ original: '[[q.pdf|![[img.png]]]]', link: 'q.pdf' },
			{ original: '[[r.pdf|![[img2.png]]', link: 'r.pdf' },
			{ original: '[[s.pdf|![[img3.png]]', link: 's.pdf' },
		],
	},
};

const NOT_FROM_OBSIDIAN: Record<string, string[]> = { '25-code-span-link-text': ['![[chart.png]]'] };

describe('server parity fixtures', () => {
	for (const [name, cache] of Object.entries(PARITY)) {
		it(`builds the refs fixture ${name} pins`, () => {
			const sidecar = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.vault.json`), 'utf8')) as Sidecar;
			const body = readFileSync(path.join(FIXTURE_DIR, `${name}.md`), 'utf8');
			for (const e of [...(cache.embeds ?? []), ...(cache.links ?? [])]) expect(body).toContain(e.original);

			const byPath = new Map(sidecar.attachments.map((r) => [r.path, r]));
			const files = sidecar.vault_paths.map((p) => tfile(p, byPath.get(p)?.size ?? 0));
			const { app } = fakeApp({ files, caches: { [sidecar.self_path]: cache } });
			const vs = new ObsidianVaultSource(app);

			const refs: NoteAttachmentRef[] = [];
			for (const r of vs.listRawRefs(sidecar.self_path)) {
				const c = classifyRef(r, vs.resolveLink(r.linkpath, sidecar.self_path));
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
