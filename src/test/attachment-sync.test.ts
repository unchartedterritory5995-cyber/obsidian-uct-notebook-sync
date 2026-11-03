import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENTS_NOTICE, prepareAttachments, YIELD_EVERY } from '../attachment-sync';
import { defaultPluginData, type PluginData } from '../types';
import { bytes, embed, FakeServer, FakeVault, shaOf, uploadFailure } from './attachment-fakes';

/** Consent already given unless a test says otherwise: the first-run "notice, no
 * uploads" rule has its own test. */
function data(over: Partial<PluginData> = {}): PluginData {
	return { ...defaultPluginData('v1'), deviceToken: 't', attachmentsNoticeShown: true, ...over };
}

function run(server: FakeServer, vault: FakeVault, d: PluginData = data()) {
	return prepareAttachments(
		{ transport: server, vaultSource: vault, data: d, serverUrl: 'https://x.test', token: 't' },
		Object.keys(vault.notes),
	);
}

const A = bytes('png A');
const B = bytes('png B');
const C = bytes('png C');

/** The longest stretch the event loop was blocked while `work` ran: a setTimeout(0)
 * ticker can only run between slices, so the largest gap between ticks is the
 * longest slice. */
async function longestSliceMs(work: () => Promise<unknown>): Promise<number> {
	let last = performance.now();
	let max = 0;
	let done = false;
	const tick = Object.assign((): void => {
		const now = performance.now();
		max = Math.max(max, now - last);
		last = now;
		if (!done) setTimeout(tick, 0);
	}, { ticker: true });
	setTimeout(tick, 0);
	await work();
	done = true;
	return Math.max(max, performance.now() - last);
}

/** A big vault: 5000 blobs, 3000 notes x 10 refs = 30k refs, resolved through a map
 * (the plain FakeVault resolves by scanning, which would time the fake, not the code). */
function bigVault(): FakeVault {
	const vault = new FakeVault();
	const byName = new Map<string, string>();
	for (let i = 0; i < 5000; i++) {
		vault.file(`att/f${i}.png`, bytes(`blob ${i}`));
		byName.set(`f${i}.png`, `att/f${i}.png`);
	}
	for (let j = 0; j < 3000; j++) {
		const refs = [];
		for (let k = 0; k < 10; k++) refs.push(embed(`f${(j * 10 + k) % 5000}.png`));
		vault.note(`n${j}.md`, 'x', refs);
	}
	vault.resolveRef = (raw) => {
		const path = byName.get(raw.linkpath);
		if (!path) return null;
		return { path, extension: 'png', size: vault.files[path]!.data.byteLength, mtime: 1 };
	};
	return vault;
}

describe('prepareAttachments on a big vault (final review I1)', () => {
	it('yields to the UI at least every YIELD_EVERY refs, and never blocks for long, over 30k refs / 5k blobs', async () => {
		const vault = bigVault();
		// Structural check (N4): count refs resolved between two yields. The yield is a
		// setTimeout(0); the ticker's own setTimeouts are ignored.
		let resolved = 0;
		const resolve = vault.resolveRef.bind(vault);
		vault.resolveRef = (raw) => { resolved += 1; return resolve(raw); };
		const marks: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
			if (ms === 0 && !(fn as { ticker?: boolean }).ticker) marks.push(resolved);
			return realSetTimeout(fn, ms);
		}) as unknown as typeof setTimeout);
		try {
			// every blob over the member's room
			const full = new FakeServer();
			full.remainingBytes = 0;
			const slice1 = await longestSliceMs(() => run(full, vault, data()));
			expect(full.uploadCalls).toEqual([]);
			const points = [0, ...marks, resolved];
			const gaps = points.slice(1).map((p, i) => p - points[i]!);
			expect(resolved).toBe(30_000);
			expect(Math.max(...gaps)).toBeLessThanOrEqual(YIELD_EVERY);

			// a 413 storage-full on the first upload marks the other 4999
			const s413 = new FakeServer();
			s413.uploadScript = [uploadFailure(413, 'Your UCT storage for imported files is full.', { storageFull: true })];
			let r: Awaited<ReturnType<typeof run>> | undefined;
			const slice2 = await longestSliceMs(async () => { r = await run(s413, vault, data()); });
			expect([...r!.refsByNote.values()].flatMap((x) => x ?? []).every((x) => x.status === 'storage-limit'))
				.toBe(true);
			// a generous wall-clock backstop (it was ~2,900 ms before the index and yields)
			expect(slice1).toBeLessThan(1000);
			expect(slice2).toBeLessThan(1000);
		} finally {
			spy.mockRestore();
		}
	}, 60_000);
});

describe('prepareAttachments hashing budget and progress (final review I2)', () => {
	function vaultOf(n: number): FakeVault {
		const vault = new FakeVault();
		for (let i = 0; i < n; i++) {
			vault.file(`att/f${i}.png`, bytes(`blob ${i}`));
			vault.note(`n${i}.md`, 'x', [embed(`f${i}.png`)]);
		}
		return vault;
	}
	const holdingAll = (vault: FakeVault): FakeServer => {
		const s = new FakeServer(); // already holds every blob: no upload reads
		for (const f of Object.values(vault.files)) s.stored.add(shaOf(f.data));
		return s;
	};

	it('stops hashing at the budget, leaves the rest of the notes pending, and the next run resumes', async () => {
		const vault = vaultOf(5);
		let now = 0;
		vault.onRead = () => { now += 1000; };
		const d = data();
		const go = () => prepareAttachments(
			{ transport: holdingAll(vault), vaultSource: vault, data: d, serverUrl: 'https://x.test', token: 't',
				clock: () => now, hashBudgetMs: 2500 },
			Object.keys(vault.notes),
		);
		const r1 = await go();
		expect(vault.readBinaryCalls).toEqual(['att/f0.png', 'att/f1.png', 'att/f2.png']);
		expect([...r1.pending].sort()).toEqual(['n3.md', 'n4.md']);
		expect(r1.refsByNote.get('n3.md')).toBeNull();
		expect(r1.refsByNote.get('n0.md')![0]!.status).toBe('ok');

		vault.readBinaryCalls = [];
		const r2 = await go();
		expect(vault.readBinaryCalls).toEqual(['att/f3.png', 'att/f4.png']); // only what run 1 did not hash
		expect(r2.pending.size).toBe(0);
		expect(Object.keys(d.attachmentHashes).sort()).toHaveLength(5);
	});

	it('saves the hash cache every 200 files, so an interrupted run loses only the last few', async () => {
		const vault = vaultOf(450);
		const d = data();
		const snapshots: number[] = [];
		let lastSaved: PluginData['attachmentHashes'] = {};
		const progress: string[] = [];
		await prepareAttachments(
			{ transport: holdingAll(vault), vaultSource: vault, data: d, serverUrl: 'https://x.test', token: 't',
				saveProgress: async () => {
					snapshots.push(Object.keys(d.attachmentHashes).length);
					lastSaved = JSON.parse(JSON.stringify(d.attachmentHashes)) as PluginData['attachmentHashes'];
				},
				onProgress: (m) => progress.push(m) },
			Object.keys(vault.notes),
		);
		expect(snapshots).toEqual([200, 400]);
		const preparing = progress.filter((m) => /preparing/i.test(m));
		expect(preparing).toHaveLength(1); // one "preparing" notice on a long run
		expect(preparing[0]).toMatch(/images and files/i);

		// the run "died" after the last save: a restart hashes only the 50 not saved
		vault.readBinaryCalls = [];
		await run(holdingAll(vault), vault, data({ attachmentHashes: lastSaved }));
		expect(vault.readBinaryCalls).toHaveLength(50);
	});
});

describe('prepareAttachments', () => {
	it('a server without attachment support maps every note to null (legacy) and never waits or reads', async () => {
		const server = new FakeServer();
		server.supported = false;
		const vault = new FakeVault().note('a.md', '![[a.png]]', [embed('a.png')]).file('att/a.png', A);
		const r = await run(server, vault);
		expect(r.supported).toBe(false);
		expect(r.refsByNote.get('a.md')).toBeNull();
		expect(server.checkCalls).toEqual([[]]);
		expect(vault.waitCalls).toEqual([]);
		expect(vault.readBinaryCalls).toEqual([]);
	});

	it('a failed first check is legacy for the run; a 401 is authExpired', async () => {
		const vault = new FakeVault().note('a.md', '![[a.png]]', [embed('a.png')]).file('att/a.png', A);
		const down = new FakeServer();
		down.checkScript = [{ ok: false, status: 0, message: 'offline', authExpired: false }];
		const r1 = await run(down, vault);
		expect(r1).toMatchObject({ supported: false, authExpired: false });
		expect(r1.refsByNote.get('a.md')).toBeNull();

		const revoked = new FakeServer();
		revoked.checkScript = [{ ok: false, status: 401, message: 'Not authenticated', authExpired: true }];
		expect(await run(revoked, vault)).toMatchObject({ authExpired: true, failMessage: 'Not authenticated' });
	});

	it('only a missing route or protocol means legacy; a transient probe failure keeps the last support state (I2)', async () => {
		const vault = new FakeVault().note('a.md', '![[a.png]]', [embed('a.png')]).file('att/a.png', A);
		const d = data();
		await run(new FakeServer(), vault, d);
		expect(d.attachmentServer).toEqual({ maxBytes: 26_214_400, maxRefsPerNote: 5000 });

		for (const status of [403, 429, 500, 502, 503, 0]) {
			const server = new FakeServer();
			server.checkScript = [{ ok: false, status, message: 'down', authExpired: false }];
			const r = await run(server, vault, d);
			expect(r.supported).toBe(true);
			expect(r.refsByNote.get('a.md')).toEqual([
				{ original: '![[a.png]]', embed: true, path: 'att/a.png', size: A.byteLength, sha256: shaOf(A), status: 'ok' },
			]);
			expect(server.checkCalls).toEqual([[]]); // nothing checked or uploaded this run
			expect(server.uploadCalls).toEqual([]);
			expect(d.attachmentServer).toEqual({ maxBytes: 26_214_400, maxRefsPerNote: 5000 });
		}

		// a missing route is the server saying "no attachments": legacy, and remembered
		const old = new FakeServer();
		old.supported = false;
		expect((await run(old, vault, d)).refsByNote.get('a.md')).toBeNull();
		expect(d.attachmentServer).toBeNull();
		// ...so a transient failure after that is legacy too
		const flaky = new FakeServer();
		flaky.checkScript = [{ ok: false, status: 502, message: 'Bad Gateway', authExpired: false }];
		expect((await run(flaky, vault, d)).refsByNote.get('a.md')).toBeNull();
	});

	it('a 404 after a supported run is legacy, never offline (final review I4)', async () => {
		const vault = new FakeVault().note('a.md', '![[a.png]]', [embed('a.png')]).file('att/a.png', A);
		const d = data();
		await run(new FakeServer(), vault, d);
		expect(d.attachmentServer).not.toBeNull();
		// the transport maps 404/405/a non-protocol 2xx to `supported: false`
		const off = new FakeServer();
		off.checkScript = [{ ok: true, supported: false }];
		const r = await run(off, vault, d);
		expect(r.supported).toBe(false);
		expect(r.refsByNote.get('a.md')).toBeNull();
		expect(d.attachmentServer).toBeNull();
		expect(r.issues).toEqual([]);
	});

	it('a check refused (403) run after run goes offline and shows a Settings issue from the 3rd run (final review I4)', async () => {
		const vault = new FakeVault().note('a.md', '![[a.png]]', [embed('a.png')]).file('att/a.png', A);
		const d = data();
		await run(new FakeServer(), vault, d);
		const refused = () => {
			const s = new FakeServer();
			s.checkScript = [{ ok: false, status: 403, message: 'Upgrade required', authExpired: false }];
			return run(s, vault, d);
		};
		const failing = { path: '', reason: 'check-failing', size: 0 };
		const r1 = await refused();
		expect(r1.supported).toBe(true); // offline: refs kept, nothing uploaded
		expect(r1.issues).toEqual([]);
		expect((await refused()).issues).toEqual([]);
		expect((await refused()).issues).toEqual([failing]);
		expect((await refused()).issues).toEqual([failing]);
		// busy (429/503) has its own issue, never both
		const busy = new FakeServer();
		busy.checkScript = [{ ok: false, status: 503, message: 'busy', authExpired: false }];
		expect((await run(busy, vault, d)).issues.map((i) => i.reason)).not.toContain('check-failing');
		// a good run clears it
		expect((await run(new FakeServer(), vault, d)).issues).toEqual([]);
		expect((await refused()).issues).toEqual([]);
	});

	it('consent: the first attachment run shows the notice and uploads NOTHING; uploads start next run', async () => {
		const vault = new FakeVault().note('a.md', '![[a.png]]', [embed('a.png')]).file('att/a.png', A);
		const log: string[] = [];
		const server = new FakeServer();
		server.onUpload = () => log.push('upload');
		const d = data({ attachmentsNoticeShown: false });
		const go = (s: FakeServer, dd: PluginData) => prepareAttachments(
			{ transport: s, vaultSource: vault, data: dd, serverUrl: 'https://x.test', token: 't',
				onProgress: (m) => log.push(`notice: ${m}`) },
			['a.md'],
		);
		// run 1: the notice, and NOTHING about files leaves the device: no list (null, the
		// 0.1.x hash), no check, no upload, not even a read
		const r1 = await go(server, d);
		expect(log).toEqual([`notice: ${ATTACHMENTS_NOTICE}`]);
		expect(ATTACHMENTS_NOTICE).toBe(
			'UCT Notebook Sync will now also sync the images and files your notes use — turn this off in Settings.');
		expect(r1.refsByNote.get('a.md')).toBeNull();
		expect(r1.pending.has('a.md')).toBe(true);
		expect(server.checkCalls).toEqual([[]]); // the probe only
		expect(server.uploadCalls).toEqual([]);
		expect(vault.readBinaryCalls).toEqual([]);
		expect(d.attachmentsNoticeShown).toBe(true); // persisted with the plugin data

		// run 2: uploads, no second notice
		log.length = 0;
		await go(server, d);
		expect(log).toEqual(['upload']);

		// the member turned the toggle off after the notice: nothing is ever uploaded
		const d3 = data({ attachmentsNoticeShown: false });
		const s3 = new FakeServer();
		await go(s3, d3);
		d3.syncAttachments = false;
		const r3 = await go(s3, d3);
		expect(s3.uploadCalls).toEqual([]);
		expect(r3.refsByNote.get('a.md')!.map((r) => [r.status, r.sha256])).toEqual([['off', null]]);

		// no notice on a text-only server, and none with the toggle already off
		const old = new FakeServer();
		old.supported = false;
		const d2 = data({ attachmentsNoticeShown: false });
		log.length = 0;
		await go(old, d2);
		await go(new FakeServer(), data({ attachmentsNoticeShown: false, syncAttachments: false }));
		expect(log).toEqual([]);
		expect(d2.attachmentsNoticeShown).toBe(false);
	});

	it('stops uploading at the per-run time or byte budget; the next run continues (I3)', async () => {
		const vault = new FakeVault();
		const refs = [];
		for (let i = 0; i < 5; i++) {
			vault.file(`att/f${i}.png`, bytes(`${i}`));
			refs.push(embed(`f${i}.png`));
		}
		vault.note('a.md', 'x', refs);

		// time: 20 s an upload against a 60 s budget -> 3 this run, 2 the next
		let now = 0;
		const server = new FakeServer();
		server.onUpload = () => { now += 20_000; };
		const timed = () => prepareAttachments(
			{ transport: server, vaultSource: vault, data: d, serverUrl: 'https://x.test', token: 't', clock: () => now },
			['a.md'],
		);
		const d = data();
		const r1 = await timed();
		expect(server.uploadCalls).toHaveLength(3);
		expect(r1.issues).toEqual([]);
		expect(r1.refsByNote.get('a.md')!.every((r) => r.status === 'ok')).toBe(true);
		server.reset();
		await timed();
		expect(server.uploadCalls).toHaveLength(2);

		// bytes: a 2-byte budget with 1-byte blobs -> 2 a run
		const s2 = new FakeServer();
		const r = await prepareAttachments(
			{ transport: s2, vaultSource: vault, data: data(), serverUrl: 'https://x.test', token: 't', uploadBudget: { ms: 1e12, bytes: 2 } },
			['a.md'],
		);
		expect(s2.uploadCalls).toHaveLength(2);
		expect(r.sent).toBe(2);
	});

	it('waits for the metadata cache, and a still-unindexed note gets null (attachments omitted), not []', async () => {
		const server = new FakeServer();
		const vault = new FakeVault()
			.note('late.md', '![[a.png]]', null)
			.note('plain.md', '# no links', [])
			.file('att/a.png', A);
		const r = await run(server, vault);
		expect(vault.waitCalls).toEqual([15000]);
		expect(r.supported).toBe(true);
		expect(r.refsByNote.get('late.md')).toBeNull();
		expect(r.refsByNote.get('plain.md')).toEqual([]);
	});

	it('hands each indexed note its body for the link-with-embed-label refs (issue #2)', async () => {
		const server = new FakeServer();
		const vault = new FakeVault()
			.note('a.md', 'x [[q.pdf|![[a.png]]]] y', [embed('a.png')])
			.note('late.md', '![[a.png]]', null)
			.file('att/a.png', A);
		await run(server, vault);
		// the unindexed note is never asked for refs
		expect(vault.rawRefBodies).toEqual([['a.md', 'x [[q.pdf|![[a.png]]]] y']]);
		// a note that cannot be read still gets the cache's refs
		const broken = new FakeVault().note('b.md', 'x', [embed('a.png')]).file('att/a.png', A);
		broken.readFile = async () => { throw new Error('locked'); };
		const r = await run(new FakeServer(), broken);
		expect(broken.rawRefBodies).toEqual([['b.md', undefined]]);
		expect(r.refsByNote.get('b.md')?.map((x) => x.path)).toEqual(['att/a.png']);
	});

	it('uploads each missing hash once, for the first path that has it', async () => {
		const server = new FakeServer();
		const vault = new FakeVault()
			.note('a.md', '![[one.png]]', [embed('one.png')])
			.note('b.md', '![[two.png]] ![[c.png]]', [embed('two.png'), embed('c.png')])
			.file('att/one.png', A).file('att/two.png', A).file('att/c.png', C);
		const r = await run(server, vault);
		expect(server.uploadCalls.map((u) => [u.sha256, u.name, u.mime])).toEqual([
			[shaOf(A), 'att/one.png', 'image/png'],
			[shaOf(C), 'att/c.png', 'image/png'],
		]);
		expect(server.checkCalls).toEqual([[], [shaOf(A), shaOf(C)]]);
		expect(r.sent).toBe(2);
		expect(r.issues).toEqual([]);
		expect(r.refsByNote.get('b.md')).toEqual([
			{ original: '![[two.png]]', embed: true, path: 'att/two.png', size: A.byteLength, sha256: shaOf(A), status: 'ok' },
			{ original: '![[c.png]]', embed: true, path: 'att/c.png', size: C.byteLength, sha256: shaOf(C), status: 'ok' },
		]);
	});

	it('checks the ok hashes of every note, in requests of at most 1000', async () => {
		const server = new FakeServer();
		const vault = new FakeVault();
		const refs = [];
		for (let i = 0; i < 1500; i++) {
			vault.file(`att/f${i}.png`, bytes(`blob ${i}`));
			refs.push(embed(`f${i}.png`));
		}
		vault.note('big.md', 'many', refs);
		await run(server, vault);
		expect(server.checkCalls.map((c) => c.length)).toEqual([0, 1000, 500]);
	});

	it('a retry-later upload (429) keeps the ref ok, records no issue and stops uploading; the next run retries', async () => {
		const server = new FakeServer();
		server.uploadScript = [uploadFailure(429, 'Too many uploads at once. Try again in a moment.', { retryLater: true })];
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('a.png'), embed('b.png')])
			.file('att/a.png', A).file('att/b.png', B);
		const r1 = await run(server, vault);
		expect(server.uploadCalls).toHaveLength(1);
		expect(r1.issues).toEqual([]);
		expect(r1.sent).toBe(0);
		expect(r1.refsByNote.get('a.md')!.map((x) => x.status)).toEqual(['ok', 'ok']);

		server.reset();
		const r2 = await run(server, vault);
		expect(server.uploadCalls.map((u) => u.sha256)).toEqual([shaOf(A), shaOf(B)]);
		expect(r2.sent).toBe(2);
	});

	it('a server busy (429/503) for 3 runs in a row shows a Settings issue; a good run clears it (M4)', async () => {
		const vault = new FakeVault().note('a.md', 'x', [embed('a.png')]).file('att/a.png', A);
		const d = data();
		const busyRun = (status: number) => {
			const s = new FakeServer();
			s.uploadScript = [uploadFailure(status, 'busy', { retryLater: true })];
			return run(s, vault, d);
		};
		const busyIssue = { path: '', reason: 'server-busy', size: 0 };
		expect((await busyRun(429)).issues).toEqual([]);
		expect((await busyRun(503)).issues).toEqual([]);
		expect((await busyRun(429)).issues).toEqual([busyIssue]);
		// a busy probe (offline run) counts too
		const probeBusy = new FakeServer();
		probeBusy.checkScript = [{ ok: false, status: 503, message: 'busy', authExpired: false }];
		expect((await run(probeBusy, vault, d)).issues).toEqual([busyIssue]);
		// a run that gets its uploads through clears it
		expect((await run(new FakeServer(), vault, d)).issues).toEqual([]);
		expect(d.attachmentBusyRuns).toBe(0);
		expect((await busyRun(429)).issues).toEqual([]);
	});

	it('the first 403 stops every upload and reports ONE issue with the server sentence', async () => {
		const server = new FakeServer();
		server.uploadScript = [uploadFailure(403, 'this vault is no longer connected')];
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('a.png'), embed('b.png'), embed('c.png')])
			.file('att/a.png', A).file('att/b.png', B).file('att/c.png', C);
		const r = await run(server, vault);
		expect(server.uploadCalls).toHaveLength(1);
		expect(r.issues).toEqual([
			{ path: 'att/a.png', reason: 'upload-failed', size: A.byteLength, message: 'this vault is no longer connected' },
		]);
		expect(r.authExpired).toBe(false);
	});

	it('a 401 on upload is authExpired', async () => {
		const server = new FakeServer();
		server.uploadScript = [uploadFailure(401, 'Not authenticated', { authExpired: true })];
		const vault = new FakeVault().note('a.md', 'x', [embed('a.png')]).file('att/a.png', A);
		expect(await run(server, vault)).toMatchObject({ authExpired: true, failMessage: 'Not authenticated' });
	});

	it('any other upload failure records upload-failed and goes on to the next', async () => {
		const server = new FakeServer();
		server.uploadScript = [null, uploadFailure(0, 'net::ERR_CONNECTION_RESET'), null];
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('a.png'), embed('b.png'), embed('c.png')])
			.file('att/a.png', A).file('att/b.png', B).file('att/c.png', C);
		const r = await run(server, vault);
		expect(server.uploadCalls).toHaveLength(3);
		expect(r.sent).toBe(2);
		expect(r.issues).toEqual([{ path: 'att/b.png', reason: 'upload-failed', size: B.byteLength }]);
		expect(r.refsByNote.get('a.md')!.map((x) => x.status)).toEqual(['ok', 'ok', 'ok']);
	});

	it('too-large, missing, storage-limit and off refs carry their status and are never uploaded', async () => {
		const server = new FakeServer();
		server.maxBytes = 6; // A ('png A') is 5 bytes: under the cap
		server.remainingBytes = 4; // ...but over the member's room
		const big = bytes('0123456789');
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('big.png'), embed('gone.png'), embed('a.png')])
			.file('att/big.png', big).file('att/a.png', A);
		const r = await run(server, vault);
		expect(server.uploadCalls).toEqual([]);
		expect(r.refsByNote.get('a.md')).toEqual([
			{ original: '![[big.png]]', embed: true, path: 'att/big.png', size: 10, sha256: null, status: 'too-large' },
			{ original: '![[gone.png]]', embed: true, path: 'gone.png', size: 0, sha256: null, status: 'missing' },
			{ original: '![[a.png]]', embed: true, path: 'att/a.png', size: 5, sha256: shaOf(A), status: 'storage-limit' },
		]);
		expect(r.issues).toEqual([
			{ path: 'att/big.png', reason: 'too-large', size: 10, limit: 6 },
			{ path: 'gone.png', reason: 'missing', size: 0 },
			{ path: 'att/a.png', reason: 'storage-limit', size: 5 },
		]);

		const off = await run(new FakeServer(), vault, data({ syncAttachments: false }));
		expect(off.refsByNote.get('a.md')!.map((x) => [x.status, x.sha256])).toEqual([
			['off', null], ['missing', null], ['off', null],
		]);
		expect(off.issues).toEqual([{ path: 'gone.png', reason: 'missing', size: 0 }]);
	});

	it('a 413 storage-full marks this and every remaining missing hash storage-limit and stops', async () => {
		const server = new FakeServer();
		server.uploadScript = [null, uploadFailure(413, 'Your UCT storage for imported files is full.', { storageFull: true })];
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('a.png'), embed('b.png'), embed('c.png')])
			.file('att/a.png', A).file('att/b.png', B).file('att/c.png', C);
		const r = await run(server, vault);
		expect(server.uploadCalls).toHaveLength(2);
		expect(r.refsByNote.get('a.md')!.map((x) => x.status)).toEqual(['ok', 'storage-limit', 'storage-limit']);
		expect(r.issues.map((i) => [i.path, i.reason])).toEqual([
			['att/b.png', 'storage-limit'], ['att/c.png', 'storage-limit'],
		]);
	});

	it('the hash cache: unchanged mtime+size never re-reads; entries for unreferenced paths are dropped', async () => {
		const server = new FakeServer();
		const vault = new FakeVault().note('a.md', 'x', [embed('a.png')]).file('att/a.png', A, 7);
		const d = data({ attachmentHashes: { 'att/old.png': { mtime: 1, size: 1, sha256: 'f'.repeat(64) } } });
		await run(server, vault, d);
		expect(vault.readBinaryCalls).toEqual(['att/a.png', 'att/a.png']); // hash, then upload
		expect(d.attachmentHashes).toEqual({ 'att/a.png': { mtime: 7, size: A.byteLength, sha256: shaOf(A) } });

		vault.readBinaryCalls = [];
		await run(server, vault, d);
		expect(vault.readBinaryCalls).toEqual([]);

		vault.file('att/a.png', B, 8);
		await run(server, vault, d);
		expect(vault.readBinaryCalls[0]).toBe('att/a.png');
		expect(d.attachmentHashes['att/a.png']!.sha256).toBe(shaOf(B));
	});

	it('uploads only bytes that hash to the ref sha; a stale cache entry is dropped and fixed next run (M1)', async () => {
		const server = new FakeServer();
		const vault = new FakeVault().note('a.md', 'x', [embed('a.png')]).file('att/a.png', B, 7);
		// a cache entry with the same mtime and size but the hash of other bytes
		const stale = bytes('png Z'); // same length as B
		expect(stale.byteLength).toBe(B.byteLength);
		const d = data({ attachmentHashes: { 'att/a.png': { mtime: 7, size: B.byteLength, sha256: shaOf(stale) } } });
		const r1 = await run(server, vault, d);
		expect(r1.refsByNote.get('a.md')![0]!.sha256).toBe(shaOf(stale));
		expect(server.uploadCalls).toEqual([]); // never sends bytes under a hash they do not have
		expect(d.attachmentHashes['att/a.png']).toBeUndefined();

		const r2 = await run(server, vault, d);
		expect(r2.refsByNote.get('a.md')![0]!.sha256).toBe(shaOf(B));
		expect(server.uploadCalls.map((u) => u.sha256)).toEqual([shaOf(B)]);
		for (const u of server.uploadCalls) expect(shaOf(new Uint8Array(u.data))).toBe(u.sha256);
	});

	it('turning sync off keeps the hash cache, so turning it back on re-reads nothing (M2)', async () => {
		const server = new FakeServer();
		const vault = new FakeVault().note('a.md', 'x', [embed('a.png')]).file('att/a.png', A, 3);
		const d = data();
		await run(server, vault, d);
		const entry = d.attachmentHashes['att/a.png'];
		expect(entry).toBeDefined();

		d.syncAttachments = false;
		await run(server, vault, d);
		expect(d.attachmentHashes['att/a.png']).toEqual(entry);

		d.syncAttachments = true;
		vault.readBinaryCalls = [];
		await run(server, vault, d);
		expect(vault.readBinaryCalls).toEqual([]);
	});

	it('uses the per-note ref cap the server advertises, and remembers it for offline runs (final review I3)', async () => {
		const refs = [];
		const vault = new FakeVault();
		for (let i = 0; i < 5; i++) refs.push(embed(`gone${i}.png`));
		vault.note('a.md', 'x', refs);
		const server = new FakeServer();
		server.maxRefsPerNote = 3;
		const d = data();
		const r = await run(server, vault, d);
		expect(r.refsByNote.get('a.md')).toHaveLength(3); // the first N go, never a 400 for the batch
		expect(r.issues).toContainEqual({ path: 'a.md', reason: 'too-many-files', size: 0, limit: 3 });
		expect(d.attachmentServer).toEqual({ maxBytes: 26_214_400, maxRefsPerNote: 3 });

		const down = new FakeServer();
		down.checkScript = [{ ok: false, status: 502, message: 'Bad Gateway', authExpired: false }];
		expect((await run(down, vault, d)).refsByNote.get('a.md')).toHaveLength(3);

		// absent: 5000
		const r2 = await run(new FakeServer(), vault, data());
		expect(r2.refsByNote.get('a.md')).toHaveLength(5);
	});

	it('enforces the server caps: original <= 2048, path <= 1024 code points, <= 5000 refs a note', async () => {
		const server = new FakeServer();
		const longName = `${'x'.repeat(1030)}.png`;
		const vault = new FakeVault()
			.note('a.md', 'x', [
				{ original: `![${'a'.repeat(2050)}](a.png)`, linkpath: 'a.png', embed: true },
				embed(longName), // missing, its path would be over 1024
				embed('a.png'),
			])
			.file('att/a.png', A);
		const r = await run(server, vault);
		expect(r.refsByNote.get('a.md')!.map((x) => x.original)).toEqual(['![[a.png]]']);
		// the server model refuses both (max_length 2048 / 1024), so neither can be sent:
		// each becomes a visible Settings issue instead of a silent loss (review I1)
		expect(r.issues).toEqual([
			{ path: 'a.png', reason: 'link-too-long', size: 0 },
			{ path: longName, reason: 'link-too-long', size: 0 },
		]);

		// an empty link path is never an attachment (classifyRef skips it before any cap
		// check), so it is neither sent nor reported; the issue's `linkpath || original`
		// fallback is a guard only
		const blank = new FakeVault().note('b.md', 'x', [
			{ original: `![${'b'.repeat(2050)}](x.png)`, linkpath: '', embed: true },
		]);
		blank.resolveRef = () => ({ path: 'att/x.png', extension: 'png', size: 1, mtime: 1 });
		const r4 = await run(new FakeServer(), blank);
		expect(r4.issues).toEqual([]);
		expect(r4.refsByNote.get('b.md')).toEqual([]);

		const many = new FakeVault();
		const refs = [];
		for (let i = 0; i < 5003; i++) refs.push(embed(`m${i}.png`));
		many.note('m.md', 'x', refs);
		const r2 = await run(new FakeServer(), many);
		// the first 5000 are sent (the server shows their notices); ONE issue for the rest
		expect(r2.refsByNote.get('m.md')).toHaveLength(5000);
		expect(r2.issues.filter((i) => i.reason === 'too-many-files'))
			.toEqual([{ path: 'm.md', reason: 'too-many-files', size: 0, limit: 5000 }]);

		// refs past 5000 that are only note links are not "files not sent"
		const links = new FakeVault();
		const mixed = [];
		for (let i = 0; i < 5000; i++) mixed.push(embed(`m${i}.png`));
		mixed.push({ original: '[[Some note]]', linkpath: 'Some note', embed: false });
		links.note('n.md', 'x', mixed);
		const r3 = await run(new FakeServer(), links);
		expect(r3.issues.filter((i) => i.reason === 'too-many-files')).toEqual([]);
	});
});
