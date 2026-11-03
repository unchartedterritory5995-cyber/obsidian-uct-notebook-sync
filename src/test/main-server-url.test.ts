/**
 * Drives the REAL UctNotebookSyncPlugin (main.ts) with a stubbed Transport:
 * the wiring between the Server URL guard and the network is where a
 * "tested green but unreachable" bug would live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestParams, RedeemParams, Transport } from '../api-client';
import UctNotebookSyncPlugin from '../main';
import { commitServerUrl } from '../settings';
import { notices, TFile } from './obsidian-stub';

class RecordingTransport implements Transport {
	redeemCalls: RedeemParams[] = [];
	ingestCalls: IngestParams[] = [];
	async redeem(p: RedeemParams) {
		this.redeemCalls.push(p);
		return { ok: true as const, deviceId: 'd', token: 't', vaultId: p.vaultId };
	}
	async ingest(p: IngestParams) {
		this.ingestCalls.push(p);
		return { ok: true as const, response: { written: 1, skipped: 0, manifestReplaced: true, tooLarge: [] } };
	}
	async checkAttachments() {
		return { ok: true as const, supported: false as const };
	}
	async uploadAttachment() {
		return { ok: true as const, stored: true };
	}
}

async function makePlugin(serverUrl: string, token: string | null = 'tok') {
	const plugin = new UctNotebookSyncPlugin();
	(plugin as any).stored = { serverUrl, deviceToken: token, vaultId: 'v1' };
	// One real note, so a sync actually reaches the transport (an empty vault
	// would make zero ingest calls and prove nothing about the URL used).
	const note = Object.assign(new TFile(), { path: 'a.md', extension: 'md', basename: 'a', stat: { mtime: 1, size: 5, ctime: 1 } });
	Object.assign((plugin as any).app.vault, {
		getMarkdownFiles: () => [note],
		getAbstractFileByPath: () => note,
		cachedRead: async () => '# hello',
	});
	const transport = new RecordingTransport();
	(plugin as any).transport = transport; // before onload builds the SyncManager
	await plugin.onload();
	return { plugin, transport };
}

const LEGACY: [string, string][] = [
	['uctintelligence.com', 'https://uctintelligence.com'],
	['https://uctintelligence.com/journal', 'https://uctintelligence.com'],
	['localhost:8077', 'https://localhost:8077'],
];

beforeEach(() => {
	notices.length = 0;
});

describe('plugin wiring of the Server URL guard', () => {
	it.each(LEGACY)('redeemConnectCode sends the normalized origin for %s', async (raw, url) => {
		const { plugin, transport } = await makePlugin(raw, null);
		const r = await plugin.redeemConnectCode('CODE');
		expect(r.ok).toBe(true);
		expect(transport.redeemCalls.map((c) => c.serverUrl)).toEqual([url]);
		expect(plugin.data.serverUrl).toBe(url);
		expect((plugin as any).saveCalls.filter((d: any) => d.serverUrl === url && d.deviceToken === null)).toHaveLength(1);
	});

	it.each(LEGACY)('runManualSync ingests against the normalized origin for %s and saves it once', async (raw, url) => {
		const { plugin, transport } = await makePlugin(raw);
		await plugin.runManualSync();
		expect(transport.ingestCalls.length).toBeGreaterThan(0);
		expect(transport.ingestCalls).toHaveLength(2); // one data batch + the manifest call
		for (const c of transport.ingestCalls) expect(c.serverUrl).toBe(url);
		expect(plugin.data.serverUrl).toBe(url);
		const normalizedSaves = (plugin as any).saveCalls.filter((d: any) => d.serverUrl === url);
		expect(normalizedSaves.length).toBeGreaterThanOrEqual(1);
		expect((plugin as any).saveCalls.filter((d: any) => d.serverUrl !== url)).toHaveLength(0);
	});

	it('an already-normalized URL is not re-saved by the guard', async () => {
		const { plugin } = await makePlugin('https://uctintelligence.com', null);
		await plugin.redeemConnectCode('CODE');
		// only the post-redeem save of the connection itself
		expect((plugin as any).saveCalls).toHaveLength(1);
	});

	it('redeemConnectCode with an invalid URL makes zero transport calls and returns the exact message', async () => {
		const { plugin, transport } = await makePlugin('http://uctintelligence.com', null);
		const r = await plugin.redeemConnectCode('CODE');
		expect(r).toEqual({
			ok: false,
			status: 0,
			message: 'Server URL is not valid: Use https:// for this address, for example https://uctintelligence.com',
		});
		expect(transport.redeemCalls).toHaveLength(0);
	});

	it('runManualSync with an invalid URL makes zero transport calls and shows the exact Notice', async () => {
		const { plugin, transport } = await makePlugin('ftp://uctintelligence.com');
		const s = await plugin.runManualSync();
		const msg =
			"Server URL is not valid: That isn't a web address. Use the address you open UCT at, for example https://uctintelligence.com";
		expect(s.ok).toBe(false);
		expect(s.error).toBe(msg);
		expect(notices).toEqual([msg]);
		expect(transport.ingestCalls).toHaveLength(0);
		expect(transport.redeemCalls).toHaveLength(0);
	});

	it('a second trigger during the URL save is refused: exactly one ingest run', async () => {
		const { plugin, transport } = await makePlugin('uctintelligence.com');
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const realSave = plugin.saveData.bind(plugin);
		plugin.saveData = async (d: unknown) => { await gate; await realSave(d); };
		const first = plugin.runManualSync();
		const second = await plugin.runManualSync(); // while the first awaits the save
		expect(second.ok).toBe(false);
		expect(second.error).toBe('A sync is already running.');
		release();
		await first;
		expect(transport.ingestCalls).toHaveLength(2); // one run = batch + manifest
		// and the lock is released afterwards
		const third = await plugin.runManualSync();
		expect(third.error).not.toBe('A sync is already running.');
	});

	it('a finished sync re-renders the settings tab while it is open, and only then (M5)', async () => {
		const { plugin } = await makePlugin('https://uctintelligence.com');
		const tab = (plugin as any).settingTab;
		expect(tab).toBeDefined();
		const display = vi.spyOn(tab, 'display').mockImplementation(() => {});
		let shown = true;
		tab.containerEl = { isShown: () => shown };
		await plugin.runManualSync();
		expect(display).toHaveBeenCalledTimes(1);
		shown = false;
		await plugin.runManualSync();
		expect(display).toHaveBeenCalledTimes(1);
	});

	it('binds the token to the origin it was redeemed against (final review I6)', async () => {
		const { plugin, transport } = await makePlugin('https://uctintelligence.com', null);
		await plugin.redeemConnectCode('CODE');
		expect(plugin.data.tokenOrigin).toBe('https://uctintelligence.com');

		// the field now names another (valid) origin: no token goes there
		plugin.data.serverUrl = 'https://uctinteligence.com';
		const s = await plugin.runManualSync();
		expect(s.ok).toBe(false);
		expect(transport.ingestCalls).toHaveLength(0);
		expect(notices.some((n) => n.includes('Server address changed'))).toBe(true);

		// back to the original origin: syncs again
		plugin.data.serverUrl = 'https://uctintelligence.com';
		expect((await plugin.runManualSync()).ok).toBe(true);
	});

	it('an upgraded install with a token binds it to the origin it already uses', async () => {
		const { plugin } = await makePlugin('uctintelligence.com', 'tok');
		expect(plugin.data.tokenOrigin).toBe('https://uctintelligence.com');
	});

	it('the Server URL field saves only on commit (blur/Enter), and only a valid value', async () => {
		const { plugin } = await makePlugin('https://uctintelligence.com', null);
		const saves = (plugin as any).saveCalls.length;
		expect(await commitServerUrl(plugin, 'https://uct')).toMatchObject({ ok: true });
		expect(plugin.data.serverUrl).toBe('https://uct');
		expect((plugin as any).saveCalls.length).toBe(saves + 1);
		expect(await commitServerUrl(plugin, 'ftp://x')).toMatchObject({ ok: false });
		expect(plugin.data.serverUrl).toBe('https://uct');
		expect((plugin as any).saveCalls.length).toBe(saves + 1);
	});

	it('commitServerUrl reports whether it saved, so Settings re-renders only then (N3)', async () => {
		const { plugin } = await makePlugin('https://uctintelligence.com', null);
		expect(await commitServerUrl(plugin, 'https://uctintelligence.com')).toMatchObject({ ok: true, saved: false });
		expect(await commitServerUrl(plugin, 'ftp://x')).toMatchObject({ ok: false, saved: false });
		expect(await commitServerUrl(plugin, 'https://other.example')).toMatchObject({ ok: true, saved: true });
	});

	it('a long sync shows a "syncing" notice; a quick one does not (final review M1)', async () => {
		const { plugin, transport } = await makePlugin('https://uctintelligence.com');
		(plugin as any).syncingNoticeDelayMs = 20;
		await plugin.runManualSync(); // quick
		expect(notices.filter((n) => n.includes('syncing'))).toEqual([]);

		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const realIngest = transport.ingest.bind(transport);
		transport.ingest = async (p: IngestParams) => { await gate; return realIngest(p); };
		const running = plugin.runManualSync();
		await new Promise((r) => setTimeout(r, 60));
		expect(notices.filter((n) => n.includes('syncing'))).toHaveLength(1);
		release();
		await running;
	});

	it('the lock is released after an invalid-URL refusal', async () => {
		const { plugin } = await makePlugin('ftp://uctintelligence.com');
		await plugin.runManualSync();
		const again = await plugin.runManualSync();
		expect(again.error).toMatch(/^Server URL is not valid/);
	});
});
