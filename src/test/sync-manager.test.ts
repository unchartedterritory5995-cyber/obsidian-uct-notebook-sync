/**
 * Integration-style tests over SyncManager with a STUBBED Transport and a
 * STUBBED VaultSource — no `obsidian` import, no network, no live server.
 * This is the suite that proves the batching/manifest/tooLarge/auth wiring
 * actually holds together end to end, not just as isolated pure functions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
	CheckOutcome, CheckParams, IngestOutcome, IngestParams, RedeemOutcome, RedeemParams, Transport,
	UploadOutcome, UploadParams,
} from '../api-client';
import { SyncManager, type VaultFileRef, type VaultSource } from '../sync-manager';
import { noteContentHash, type RawLinkRef, type ResolvedFile } from '../attachment-refs';
import { sha256Hex } from '../hashing';
import { bytes, embed, FakeServer, FakeVault, shaOf, uploadFailure } from './attachment-fakes';
import { defaultPluginData, type PluginData } from '../types';

class FakeVaultSource implements VaultSource {
	constructor(private files: Record<string, string>) {}

	async listMarkdownFiles(): Promise<VaultFileRef[]> {
		return Object.keys(this.files).map((path) => ({ path, mtime: 1_700_000_000_000 }));
	}

	async readFile(path: string): Promise<string> {
		const body = this.files[path];
		if (body === undefined) throw new Error(`no such file: ${path}`);
		return body;
	}

	// The attachment half of VaultSource (Plan C Task 8/10): a text-only vault,
	// every note indexed and holding no links.
	async whenMetadataReady(): Promise<void> {}
	isIndexed(): boolean { return true; }
	listRawRefs(): RawLinkRef[] { return []; }
	resolveLink(): ResolvedFile | null { return null; }
	resolveRef(): ResolvedFile | null { return null; }
	async readBinary(path: string): Promise<ArrayBuffer> { throw new Error(`no binary: ${path}`); }
}

/** Records every ingest call it receives (in order) and answers from a
 * scripted queue — the "stubbed transport" the task requires. */
class FakeTransport implements Transport {
	ingestCalls: IngestParams[] = [];
	redeemCalls: RedeemParams[] = [];
	private ingestQueue: IngestOutcome[] = [];
	private redeemQueue: RedeemOutcome[] = [];

	queueIngest(outcome: IngestOutcome): this {
		this.ingestQueue.push(outcome);
		return this;
	}

	queueRedeem(outcome: RedeemOutcome): this {
		this.redeemQueue.push(outcome);
		return this;
	}

	async ingest(params: IngestParams): Promise<IngestOutcome> {
		this.ingestCalls.push(params);
		const next = this.ingestQueue.shift();
		if (!next) throw new Error('FakeTransport.ingest called with no queued outcome');
		return next;
	}

	async redeem(params: RedeemParams): Promise<RedeemOutcome> {
		this.redeemCalls.push(params);
		const next = this.redeemQueue.shift();
		if (!next) throw new Error('FakeTransport.redeem called with no queued outcome');
		return next;
	}

	// Scripted attachment calls (Plan C Task 9). With nothing queued, check answers
	// "unsupported" (a 0.1.x server), so every pre-attachment test runs unchanged.
	checkCalls: CheckParams[] = [];
	uploadCalls: UploadParams[] = [];
	private checkQueue: CheckOutcome[] = [];
	private uploadQueue: UploadOutcome[] = [];

	queueCheck(outcome: CheckOutcome): this {
		this.checkQueue.push(outcome);
		return this;
	}

	queueUpload(outcome: UploadOutcome): this {
		this.uploadQueue.push(outcome);
		return this;
	}

	async checkAttachments(params: CheckParams): Promise<CheckOutcome> {
		this.checkCalls.push(params);
		return this.checkQueue.shift() ?? { ok: true, supported: false };
	}

	async uploadAttachment(params: UploadParams): Promise<UploadOutcome> {
		this.uploadCalls.push(params);
		const next = this.uploadQueue.shift();
		if (!next) throw new Error('FakeTransport.uploadAttachment called with no queued outcome');
		return next;
	}
}

function okIngest(overrides: Partial<IngestOutcome & { ok: true }> = {}): IngestOutcome {
	return {
		ok: true,
		response: { written: 0, skipped: 0, manifestReplaced: false, tooLarge: [] },
		...overrides,
	};
}

function makeData(overrides: Partial<PluginData> = {}): PluginData {
	return { ...defaultPluginData('vault-uuid-1'), deviceToken: 'device-token-1', ...overrides };
}

describe('SyncManager.runSync', () => {
	let data: PluginData;
	let saved: PluginData[];

	beforeEach(() => {
		saved = [];
	});

	function manager(transport: FakeTransport, vaultSource: VaultSource, initial: PluginData) {
		data = initial;
		return new SyncManager({
			transport,
			vaultSource,
			getData: () => data,
			saveData: async (d) => {
				data = d;
				saved.push(structuredClone(d));
			},
			now: () => '2026-09-02T12:00:00.000Z',
		});
	}

	it('refuses to run without a device token, and makes no transport calls', async () => {
		const transport = new FakeTransport();
		const sm = manager(transport, new FakeVaultSource({}), makeData({ deviceToken: null }));
		const summary = await sm.runSync();
        expect(summary.ok).toBe(false);
		expect(summary.needsReconnect).toBe(true);
		expect(transport.ingestCalls).toHaveLength(0);
	});

	it('an empty vault sends nothing and succeeds', async () => {
		const transport = new FakeTransport();
		const sm = manager(transport, new FakeVaultSource({}), makeData());
		const summary = await sm.runSync();
		expect(summary.ok).toBe(true);
		expect(summary.manifestSent).toBe(false);
		expect(transport.ingestCalls).toHaveLength(0);
	});

	it('a first sync pushes every file in one batch, then sends the final manifest', async () => {
		const transport = new FakeTransport()
			.queueIngest(okIngest({ response: { written: 2, skipped: 0, manifestReplaced: false, tooLarge: [] } }))
			.queueIngest(okIngest({ response: { written: 0, skipped: 0, manifestReplaced: true, tooLarge: [] } }));
		const sm = manager(
			transport,
			new FakeVaultSource({ 'a.md': '# A', 'b.md': '# B' }),
			makeData(),
		);
		const summary = await sm.runSync();

		expect(summary.ok).toBe(true);
		expect(summary.pushed).toBe(2);
		expect(summary.manifestSent).toBe(true);
		expect(transport.ingestCalls).toHaveLength(2);

		const [contentCall, manifestCall] = transport.ingestCalls;
		expect(contentCall!.final).toBe(false);
		expect(contentCall!.notes.map((n) => n.vault_path).sort()).toEqual(['a.md', 'b.md']);
		expect(contentCall!.manifest).toBeUndefined();

		expect(manifestCall!.final).toBe(true);
		expect(manifestCall!.notes).toEqual([]);
		expect(manifestCall!.manifest?.sort()).toEqual(['a.md', 'b.md']);

		// State persisted for both files.
		expect(data.files['a.md']).toMatchObject({ tooLarge: false, syncedAt: '2026-09-02T12:00:00.000Z' });
		expect(data.files['b.md']).toMatchObject({ tooLarge: false, syncedAt: '2026-09-02T12:00:00.000Z' });
	});

	it('splits changed notes across multiple batches when the count ceiling is small', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 5; i++) files[`n${i}.md`] = `# note ${i}`;
		const transport = new FakeTransport()
			.queueIngest(okIngest({ response: { written: 2, skipped: 0, manifestReplaced: false, tooLarge: [] } }))
			.queueIngest(okIngest({ response: { written: 2, skipped: 0, manifestReplaced: false, tooLarge: [] } }))
			.queueIngest(okIngest({ response: { written: 1, skipped: 0, manifestReplaced: false, tooLarge: [] } }))
			.queueIngest(okIngest({ response: { written: 0, skipped: 0, manifestReplaced: true, tooLarge: [] } }));
		const sm = new SyncManager({
			transport,
			vaultSource: new FakeVaultSource(files),
			getData: () => data,
			saveData: async (d) => {
				data = d;
			},
			now: () => 'now',
			batchOptions: { maxNotes: 2, maxBytes: 1_000_000 },
		});
		data = makeData();
		const summary = await sm.runSync();

		expect(summary.ok).toBe(true);
		expect(summary.pushed).toBe(5);
		// 3 content batches (2,2,1) + 1 final manifest call.
		expect(transport.ingestCalls).toHaveLength(4);
		expect(transport.ingestCalls.slice(0, 3).every((c) => c.final === false)).toBe(true);
		expect(transport.ingestCalls[3]!.final).toBe(true);
	});

	it('a second sync with nothing changed pushes no content but still refreshes the manifest', async () => {
		const initial = makeData({ files: { 'a.md': { hash: '', syncedAt: 't0', tooLarge: false } } });
		// Compute the real hash so "unchanged" is genuine, not a fluke.
		const { sha256Hex } = await import('../hashing');
		initial.files['a.md']!.hash = sha256Hex('# A');

		const transport = new FakeTransport().queueIngest(
			okIngest({ response: { written: 0, skipped: 0, manifestReplaced: true, tooLarge: [] } }),
		);
		const sm = manager(transport, new FakeVaultSource({ 'a.md': '# A' }), initial);
		const summary = await sm.runSync();

		expect(summary.ok).toBe(true);
		expect(summary.pushed).toBe(0);
		expect(summary.skippedUnchanged).toBe(1);
		// Exactly one call: the final manifest alone, no content batch.
		expect(transport.ingestCalls).toHaveLength(1);
		expect(transport.ingestCalls[0]!.final).toBe(true);
		expect(transport.ingestCalls[0]!.notes).toEqual([]);
		expect(transport.ingestCalls[0]!.manifest).toEqual(['a.md']);
	});

	it('a note reported tooLarge is excluded from this run’s manifest and from the NEXT run’s push', async () => {
		const transport = new FakeTransport()
			.queueIngest(
				okIngest({ response: { written: 0, skipped: 0, manifestReplaced: false, tooLarge: ['huge.md'] } }),
			);
			// No second queued call expected — manifestPaths is empty once
			// the only file is excluded, so phase 2 must be skipped.
		const sm = manager(transport, new FakeVaultSource({ 'huge.md': 'x'.repeat(500_000) }), makeData());
		const summary = await sm.runSync();

		expect(summary.ok).toBe(true);
		expect(summary.tooLarge).toEqual(['huge.md']);
		expect(summary.manifestSent).toBe(false);
		// Only ONE ingest call was made at all — the manifest phase was
		// correctly skipped rather than sending an empty `manifest: []`.
		expect(transport.ingestCalls).toHaveLength(1);
		expect(data.files['huge.md']).toMatchObject({ tooLarge: true });

		// Second run, file unchanged: must not be re-pushed, and (being the
		// vault's only file, still too large) still sends nothing.
		const transport2 = new FakeTransport();
		const sm2 = manager(transport2, new FakeVaultSource({ 'huge.md': 'x'.repeat(500_000) }), data);
		const summary2 = await sm2.runSync();
		expect(summary2.ok).toBe(true);
		expect(transport2.ingestCalls).toHaveLength(0);
		expect(summary2.skippedTooLargeUnchanged).toEqual(['huge.md']);
	});

	it('a too-large note is retried once the member edits it', async () => {
		const priorData = makeData({
			files: { 'huge.md': { hash: 'stale-hash', syncedAt: '', tooLarge: true } },
		});
		const transport = new FakeTransport()
			.queueIngest(okIngest({ response: { written: 1, skipped: 0, manifestReplaced: false, tooLarge: [] } }))
			.queueIngest(okIngest({ response: { written: 0, skipped: 0, manifestReplaced: true, tooLarge: [] } }));
		const sm = manager(transport, new FakeVaultSource({ 'huge.md': '# shortened now' }), priorData);
		const summary = await sm.runSync();

		expect(summary.ok).toBe(true);
		expect(summary.pushed).toBe(1);
		expect(transport.ingestCalls[0]!.notes.map((n) => n.vault_path)).toEqual(['huge.md']);
		expect(data.files['huge.md']).toMatchObject({ tooLarge: false });
	});

	it('a note that grew past the ceiling AFTER syncing fine once stays in the manifest — no spurious deletion', async () => {
		// "grown.md" synced successfully before (non-empty syncedAt); the
		// member then grew it, so this run's push fails again. Its manifest
		// entry must survive regardless — the server's own
		// `j2_obsidian_staging` row for this path still holds the OLDER,
		// successfully-staged content, so omitting it here would look
		// exactly like the member deleted an already-imported note.
		const priorData = makeData({
			files: {
				'grown.md': { hash: 'old-small-hash', syncedAt: '2026-08-01T00:00:00Z', tooLarge: false },
				'sibling.md': { hash: '', syncedAt: '2026-08-01T00:00:00Z' },
			},
		});
		const { sha256Hex } = await import('../hashing');
		priorData.files['sibling.md']!.hash = sha256Hex('# sibling, unchanged');

		const transport = new FakeTransport()
			.queueIngest(
				okIngest({ response: { written: 0, skipped: 0, manifestReplaced: false, tooLarge: ['grown.md'] } }),
			)
			.queueIngest(okIngest({ response: { written: 0, skipped: 0, manifestReplaced: true, tooLarge: [] } }));
		const sm = manager(
			transport,
			new FakeVaultSource({ 'grown.md': 'x'.repeat(500_000), 'sibling.md': '# sibling, unchanged' }),
			priorData,
		);
		const summary = await sm.runSync();

		expect(summary.ok).toBe(true);
		expect(summary.tooLarge).toEqual(['grown.md']);
		// The manifest call must still name BOTH paths.
		expect(transport.ingestCalls[1]!.final).toBe(true);
		expect(transport.ingestCalls[1]!.manifest?.sort()).toEqual(['grown.md', 'sibling.md']);
		expect(data.files['grown.md']).toMatchObject({ tooLarge: true, syncedAt: '2026-08-01T00:00:00Z' });
	});

	it('a deleted file drops out of the manifest and out of local state', async () => {
		const priorData = makeData({
			files: {
				'keep.md': { hash: 'h-keep', syncedAt: 't0' },
				'deleted.md': { hash: 'h-del', syncedAt: 't0' },
			},
		});
		const { sha256Hex } = await import('../hashing');
		priorData.files['keep.md']!.hash = sha256Hex('# keep');

		const transport = new FakeTransport().queueIngest(
			okIngest({ response: { written: 0, skipped: 0, manifestReplaced: true, tooLarge: [] } }),
		);
		const sm = manager(transport, new FakeVaultSource({ 'keep.md': '# keep' }), priorData);
		const summary = await sm.runSync();

		expect(summary.deletedLocally).toEqual(['deleted.md']);
		expect(transport.ingestCalls[0]!.manifest).toEqual(['keep.md']);
		expect(data.files['deleted.md']).toBeUndefined();
	});

	it('stops the run on a mid-batch failure and never sends the manifest for unpushed content', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 3; i++) files[`n${i}.md`] = `# note ${i}`;
		const transport = new FakeTransport()
			.queueIngest(okIngest({ response: { written: 1, skipped: 0, manifestReplaced: false, tooLarge: [] } }))
			.queueIngest({ ok: false, status: 502, message: 'upstream unavailable', authExpired: false });
		const sm = new SyncManager({
			transport,
			vaultSource: new FakeVaultSource(files),
			getData: () => data,
			saveData: async (d) => {
				data = d;
			},
			now: () => 'now',
			batchOptions: { maxNotes: 1, maxBytes: 1_000_000 },
		});
		data = makeData();
		const summary = await sm.runSync();

		expect(summary.ok).toBe(false);
		expect(summary.needsReconnect).toBe(false);
		expect(summary.error).toBe('upstream unavailable');
		// Exactly the two attempted calls — the run stopped, no manifest call.
		expect(transport.ingestCalls).toHaveLength(2);
		expect(transport.ingestCalls.every((c) => c.final !== true)).toBe(true);
		// The token must NOT have been cleared for a non-auth failure.
		expect(data.deviceToken).toBe('device-token-1');
		expect(data.lastSyncError).toBe('upstream unavailable');
	});

	it('a 401 clears the device token, keeps vaultId, and asks for reconnection instead of looping', async () => {
		const transport = new FakeTransport().queueIngest({
			ok: false,
			status: 401,
			message: 'Not authenticated',
			authExpired: true,
		});
		const sm = manager(transport, new FakeVaultSource({ 'a.md': '# A' }), makeData({ vaultId: 'stable-vault-id' }));
		const summary = await sm.runSync();

		expect(summary.ok).toBe(false);
		expect(summary.needsReconnect).toBe(true);
		expect(data.deviceToken).toBeNull();
		expect(data.vaultId).toBe('stable-vault-id');
		// Exactly one call was made — a 401 must not trigger an automatic retry.
		expect(transport.ingestCalls).toHaveLength(1);
	});
});

// ── Plan C Task 10: sync with attachments ──

describe('SyncManager.runSync with attachments', () => {
	let store: PluginData;
	const B = bytes('the chart');

	function mgr(server: FakeServer, vault: FakeVault, initial?: PluginData) {
		if (initial) store = initial;
		return new SyncManager({
			transport: server,
			vaultSource: vault,
			getData: () => store,
			saveData: async (d) => { store = JSON.parse(JSON.stringify(d)) as PluginData; },
			now: () => '2026-11-02T00:00:00.000Z',
		});
	}

	beforeEach(() => {
		store = makeData();
	});

	it('uploads a referenced image once, then pushes the note with its ref and an attachment-aware hash', async () => {
		const t = new FakeServer();
		const vault = new FakeVault().note('a.md', '![[chart.png]]', [embed('chart.png')]).file('att/chart.png', B);
		const s = await mgr(t, vault).runSync();
		expect(s.ok).toBe(true);
		expect(t.uploadCalls.map((u) => u.sha256)).toEqual([shaOf(B)]);
		const note = t.ingestCalls[0]!.notes[0]!;
		expect(note.attachments).toEqual([
			{ original: '![[chart.png]]', embed: true, path: 'att/chart.png', size: B.byteLength, sha256: shaOf(B), status: 'ok' },
		]);
		expect(note.content_hash).toBe(noteContentHash('![[chart.png]]', note.attachments!));
		expect(s.attachmentsSent).toBe(1);
		expect(s.attachmentIssues).toBe(0);
	});

	it('dedupes uploads by content hash across notes and renames', async () => {
		const t = new FakeServer();
		const vault = new FakeVault()
			.note('a.md', '![[one.png]]', [embed('one.png')])
			.note('b.md', '![[two.png]]', [embed('two.png')])
			.file('att/one.png', B).file('att/two.png', B);
		const m = mgr(t, vault);
		await m.runSync();
		expect(t.uploadCalls).toHaveLength(1);
		expect(t.pushedNotes().map((n) => n.vault_path)).toEqual(['a.md', 'b.md']);

		// rename both binaries (same bytes): the path is in the hash, so both notes re-push once
		delete vault.files['att/one.png'];
		delete vault.files['att/two.png'];
		vault.file('img/one.png', B).file('img/two.png', B);
		t.reset();
		await m.runSync();
		expect(t.uploadCalls).toEqual([]);
		expect(t.pushedNotes().map((n) => [n.vault_path, n.attachments![0]!.path])).toEqual([
			['a.md', 'img/one.png'], ['b.md', 'img/two.png'],
		]);

		t.reset();
		await m.runSync();
		expect(t.pushedNotes()).toEqual([]);
		expect(t.uploadCalls).toEqual([]);
	});

	it('legacy server keeps 0.1.x hashes, then re-sends attachment notes once after server upgrade', async () => {
		const t = new FakeServer();
		t.supported = false;
		const vault = new FakeVault()
			.note('a.md', '![[chart.png]]', [embed('chart.png')])
			.note('plain.md', '# plain', [])
			.file('att/chart.png', B);
		const m = mgr(t, vault);
		const s1 = await m.runSync();
		expect(s1.attachmentsSent).toBe(0);
		expect(t.uploadCalls).toEqual([]);
		for (const n of t.pushedNotes()) {
			expect('attachments' in n).toBe(false);
			expect(n.content_hash).toBe(sha256Hex(n.body_md));
		}

		t.supported = true;
		t.reset();
		await m.runSync();
		expect(t.pushedNotes().map((n) => n.vault_path)).toEqual(['a.md']);
		expect(t.uploadCalls).toHaveLength(1);

		t.reset();
		await m.runSync();
		expect(t.pushedNotes()).toEqual([]);
	});

	it('an upload failure never blocks notes and the next run uploads only what is missing', async () => {
		const t = new FakeServer();
		t.uploadScript = [null, uploadFailure(0, 'net::ERR_CONNECTION_RESET'), null];
		const [x, y, z] = [bytes('x'), bytes('y'), bytes('z')];
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('x.png'), embed('y.png'), embed('z.png')])
			.file('att/x.png', x).file('att/y.png', y).file('att/z.png', z);
		const m = mgr(t, vault);
		const s1 = await m.runSync();
		expect(s1.ok).toBe(true);
		expect(t.pushedNotes().map((n) => n.vault_path)).toEqual(['a.md']);
		expect(store.attachmentIssues).toEqual([{ path: 'att/y.png', reason: 'upload-failed', size: 1 }]);

		t.reset();
		const s2 = await m.runSync();
		expect(t.pushedNotes()).toEqual([]);
		expect(t.uploadCalls.map((u) => u.sha256)).toEqual([shaOf(y)]);
		expect(store.attachmentIssues).toEqual([]);
		expect(s2.attachmentsSent).toBe(1);
	});

	it('a note indexed late re-pushes once with its attachments', async () => {
		const t = new FakeServer();
		const vault = new FakeVault().note('a.md', '![[chart.png]]', null).file('att/chart.png', B);
		const m = mgr(t, vault);
		await m.runSync();
		const first = t.pushedNotes()[0]!;
		expect('attachments' in first).toBe(false); // omitted, not []
		expect(first.content_hash).toBe(sha256Hex('![[chart.png]]'));

		vault.refs['a.md'] = [embed('chart.png')];
		t.reset();
		await m.runSync();
		expect(t.pushedNotes().map((n) => n.attachments)).toEqual([[
			{ original: '![[chart.png]]', embed: true, path: 'att/chart.png', size: B.byteLength, sha256: shaOf(B), status: 'ok' },
		]]);

		t.reset();
		await m.runSync();
		expect(t.pushedNotes()).toEqual([]);
	});

	it('too-large, missing and storage-limit refs are sent with their status and never uploaded', async () => {
		const t = new FakeServer();
		t.maxBytes = 4;
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('big.png'), embed('gone.pdf')])
			.file('att/big.png', B);
		const s = await mgr(t, vault).runSync();
		expect(t.uploadCalls).toEqual([]);
		expect(t.pushedNotes()[0]!.attachments!.map((r) => r.status)).toEqual(['too-large', 'missing']);
		expect(s.attachmentIssues).toBe(2);

		const t2 = new FakeServer();
		t2.remainingBytes = 1;
		const v2 = new FakeVault().note('a.md', 'x', [embed('c.png')]).file('att/c.png', B);
		await mgr(t2, v2, makeData()).runSync();
		expect(t2.uploadCalls).toEqual([]);
		expect(t2.pushedNotes()[0]!.attachments![0]).toMatchObject({ status: 'storage-limit', sha256: shaOf(B) });
	});

	it('a 413 storage-full stops further uploads in the run', async () => {
		const t = new FakeServer();
		t.uploadScript = [uploadFailure(413, 'Your UCT storage for imported files is full.', { storageFull: true })];
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('p.png'), embed('q.png')])
			.file('att/p.png', bytes('p')).file('att/q.png', bytes('q'));
		const s = await mgr(t, vault).runSync();
		expect(s.ok).toBe(true);
		expect(t.uploadCalls).toHaveLength(1);
		expect(t.pushedNotes()[0]!.attachments!.map((r) => r.status)).toEqual(['storage-limit', 'storage-limit']);
	});

	it('turning attachment sync off sends status off and uploads nothing; turning it back on re-sends', async () => {
		const t = new FakeServer();
		const vault = new FakeVault().note('a.md', '![[chart.png]]', [embed('chart.png')]).file('att/chart.png', B);
		const m = mgr(t, vault, makeData({ syncAttachments: false }));
		await m.runSync();
		expect(t.uploadCalls).toEqual([]);
		expect(t.pushedNotes()[0]!.attachments).toEqual([
			{ original: '![[chart.png]]', embed: true, path: 'att/chart.png', size: B.byteLength, sha256: null, status: 'off' },
		]);

		store.syncAttachments = true;
		t.reset();
		await m.runSync();
		expect(t.uploadCalls).toHaveLength(1);
		expect(t.pushedNotes()[0]!.attachments![0]!.status).toBe('ok');
	});

	it('a 401 on check or upload clears the token and reports needsReconnect', async () => {
		const vault = new FakeVault().note('a.md', '![[chart.png]]', [embed('chart.png')]).file('att/chart.png', B);
		const t1 = new FakeServer();
		t1.checkScript = [{ ok: false, status: 401, message: 'Not authenticated', authExpired: true }];
		const s1 = await mgr(t1, vault, makeData()).runSync();
		expect(s1).toMatchObject({ ok: false, needsReconnect: true });
		expect(store.deviceToken).toBeNull();
		expect(t1.ingestCalls).toEqual([]);

		const t2 = new FakeServer();
		t2.uploadScript = [uploadFailure(401, 'Not authenticated', { authExpired: true })];
		const s2 = await mgr(t2, vault, makeData()).runSync();
		expect(s2).toMatchObject({ ok: false, needsReconnect: true });
		expect(store.deviceToken).toBeNull();
		expect(t2.ingestCalls).toEqual([]);
	});

	it('a transient probe failure after a good run re-pushes nothing (no flip to a list-less push)', async () => {
		const t = new FakeServer();
		const vault = new FakeVault()
			.note('a.md', '![[chart.png]]', [embed('chart.png')])
			.note('b.md', '# plain', [])
			.file('att/chart.png', B);
		const m = mgr(t, vault);
		await m.runSync();
		expect(t.pushedNotes()).toHaveLength(2);

		t.reset();
		t.checkScript = [{ ok: false, status: 503, message: 'Service Unavailable', authExpired: false }];
		const s = await m.runSync();
		expect(s.ok).toBe(true);
		expect(t.pushedNotes()).toEqual([]);
		expect(t.uploadCalls).toEqual([]);
	});

	it('a 403 on upload stops uploads but the notes are still pushed', async () => {
		const t = new FakeServer();
		t.uploadScript = [uploadFailure(403, 'Upgrade required')];
		const vault = new FakeVault()
			.note('a.md', 'x', [embed('p.png'), embed('q.png')])
			.file('att/p.png', bytes('p')).file('att/q.png', bytes('q'));
		const s = await mgr(t, vault).runSync();
		expect(s.ok).toBe(true);
		expect(t.uploadCalls).toHaveLength(1);
		expect(t.pushedNotes().map((n) => n.vault_path)).toEqual(['a.md']);
		expect(store.attachmentIssues).toEqual([{ path: 'att/p.png', reason: 'upload-failed', size: 1, message: 'Upgrade required' }]);
	});

	it('attachment hash cache: unchanged mtime+size never re-reads the binary', async () => {
		const t = new FakeServer();
		const vault = new FakeVault().note('a.md', '![[chart.png]]', [embed('chart.png')]).file('att/chart.png', B);
		const m = mgr(t, vault);
		await m.runSync();
		expect(vault.readBinaryCalls).toContain('att/chart.png'); // the first run did hash it
		vault.readBinaryCalls = [];
		await m.runSync();
		expect(vault.readBinaryCalls).toEqual([]);
		expect(t.checkCalls.at(-1)).toEqual([shaOf(B)]); // still checked, from the cached hash
	});

	it('the manifest never names an attachment path', async () => {
		const t = new FakeServer();
		const vault = new FakeVault()
			.note('a.md', '![[chart.png]]', [embed('chart.png')])
			.note('b.md', '# b', [])
			.file('att/chart.png', B);
		await mgr(t, vault).runSync();
		expect(t.uploadCalls).toHaveLength(1);
		const final = t.ingestCalls.find((c) => c.final === true)!;
		expect([...final.manifest!].sort()).toEqual(['a.md', 'b.md']);
	});
});
