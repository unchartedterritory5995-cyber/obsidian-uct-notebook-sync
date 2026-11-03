/**
 * Plugin entry point. Wires the pure logic in sync-manager.ts/sync-plan.ts/
 * batching.ts/hashing.ts to real Obsidian primitives: persisted settings
 * (`loadData`/`saveData`), the vault (`ObsidianVaultSource`), the network
 * (`ObsidianHttpTransport`), a ribbon icon, a command, and the settings tab.
 *
 * See README.md for the wire contract this plugin implements and the
 * server-side repo it talks to.
 */
import { Notice, Plugin } from 'obsidian';
import { ObsidianHttpTransport, type RedeemOutcome } from './api-client';
import { normalizeSavedServerUrl, validateServerUrl } from './server-url';
import { UctNotebookSyncSettingTab } from './settings';
import { SyncManager, type SyncSummary } from './sync-manager';
import { defaultPluginData, type PluginData, clearStagedState} from './types';
import { ObsidianVaultSource } from './vault-source';

export default class UctNotebookSyncPlugin extends Plugin {
	data!: PluginData;
	private transport = new ObsidianHttpTransport();
	private syncManager!: SyncManager;
	private settingTab!: UctNotebookSyncSettingTab;
	private syncing = false;

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.syncManager = new SyncManager({
			transport: this.transport,
			vaultSource: new ObsidianVaultSource(this.app),
			getData: () => this.data,
			saveData: (data) => this.saveData(data),
			onProgress: (message) => { new Notice(message); },
		});

		this.settingTab = new UctNotebookSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.addRibbonIcon('refresh-cw', 'Sync to UCT Notebook', () => {
			void this.runManualSync();
		});

		this.addCommand({
			// ⛔ NOT 'uct-notebook-sync-now': Obsidian already namespaces a
			// command as `<plugin-id>:<id>`, so repeating the plugin id here
			// ships the member a command called
			// "uct-notebook-sync:uct-notebook-sync-now".
			id: 'sync-now',
			name: 'Sync vault to UCT Notebook',
			callback: () => {
				void this.runManualSync();
			},
		});
	}

	onunload(): void {
		// The hash cache is written into `data` as files are hashed: saving here keeps a
		// sync cut short by closing Obsidian from re-reading those files (final review I2).
		if (this.data) void this.saveData(this.data);
	}

	private async loadPluginData(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginData> | null;
		// `vaultId` must survive verbatim across every reload once minted —
		// see types.ts's own docstring on why reusing it is what makes a
		// reconnect ROTATE the server's device row instead of creating a
		// second, orphaned one. Only ever generated ONCE, on a genuinely
		// fresh install (no stored data at all, or a pre-existing blob
		// missing it for some reason).
		const vaultId = stored?.vaultId ?? crypto.randomUUID();
		this.data = { ...defaultPluginData(vaultId), ...stored, vaultId };
		// An install upgraded with a token already in use binds it to the origin it is
		// already sending it to, so the origin guard (final review I6) changes nothing
		// for it until the field is edited.
		if (this.data.deviceToken && this.data.tokenOrigin === null) {
			const current = validateServerUrl(this.data.serverUrl);
			if (current.ok) this.data.tokenOrigin = current.url;
		}
	}

	async redeemConnectCode(code: string): Promise<RedeemOutcome> {
		const urlCheck = await normalizeSavedServerUrl(this.data, () => this.saveData(this.data));
		if (!urlCheck.ok) {
			return { ok: false, status: 0, message: `Server URL is not valid: ${urlCheck.message}` };
		}
		const label = this.app.vault.getName();
		const result = await this.transport.redeem({
			serverUrl: urlCheck.url,
			code,
			vaultId: this.data.vaultId,
			label,
		});
		if (result.ok) {
			// ⛔ The server purges this vault's staging AND manifest on
			// disconnect, so a redeemed code always means an EMPTY staging
			// area. Carrying the old per-file state over makes the next sync
			// push nothing while still manifesting every path, which the
			// server refuses outright — a vault that silently stops syncing
			// and never recovers. Start from a clean slate so the next sync
			// is a full re-push.
			this.data = clearStagedState(this.data);
			this.data.deviceToken = result.token;
			this.data.tokenOrigin = urlCheck.url;
			this.data.connectedLabel = label;
			this.data.connectedAt = new Date().toISOString();
			await this.saveData(this.data);
		}
		return result;
	}

	async runManualSync(): Promise<SyncSummary> {
		if (this.syncing) {
			new Notice('A sync is already running.');
			return refusedSummary('A sync is already running.');
		}
		// The lock is taken BEFORE the first await (the URL normalizer saves),
		// so a second trigger during that save is refused, and it is released
		// on every path out, including the invalid-URL refusal.
		this.syncing = true;
		try {
			const urlCheck = await normalizeSavedServerUrl(this.data, () => this.saveData(this.data));
			if (!urlCheck.ok) {
				const error = `Server URL is not valid: ${urlCheck.message}`;
				new Notice(error);
				return refusedSummary(error);
			}
			const summary = await this.syncManager.runSync();
			new Notice(summarize(summary));
			if (summary.ok && summary.attachmentsSupported && this.data.syncAttachments
				&& !this.data.attachmentsNoticeShown) {
				new Notice(
					'UCT Notebook Sync now also sends the images and files your notes use. ' +
					'You can turn this off in its settings.',
				);
				this.data.attachmentsNoticeShown = true;
				await this.saveData(this.data);
			}
			this.settingTab.refreshIfOpen();
			return summary;
		} finally {
			this.syncing = false;
		}
	}
}

function refusedSummary(error: string): SyncSummary {
	return {
		ok: false,
		scanned: 0,
		pushed: 0,
		skippedUnchanged: 0,
		tooLarge: [],
		skippedTooLargeUnchanged: [],
		deletedLocally: [],
		manifestSent: false,
		needsReconnect: false,
		attachmentsSupported: false,
		attachmentsSent: 0,
		attachmentIssues: 0,
		error,
	};
}

function summarize(summary: SyncSummary): string {
	if (summary.needsReconnect) {
		return 'UCT Notebook Sync: not connected. Reconnect in Settings.';
	}
	if (!summary.ok) {
		return `UCT Notebook Sync failed: ${summary.error ?? 'unknown error'}`;
	}
	const parts = [`${summary.pushed} note${summary.pushed === 1 ? '' : 's'} synced`];
	if (summary.tooLarge.length > 0) {
		parts.push(`${summary.tooLarge.length} too large (see Settings)`);
	}
	if (summary.deletedLocally.length > 0) {
		parts.push(`${summary.deletedLocally.length} removed`);
	}
	if (summary.attachmentsSent > 0) {
		parts.push(`${summary.attachmentsSent} image/file${summary.attachmentsSent === 1 ? '' : 's'} sent`);
	}
	if (summary.attachmentIssues > 0) {
		parts.push(`${summary.attachmentIssues} could not be sent (see Settings)`);
	}
	return `UCT Notebook Sync: ${parts.join(', ')}.`;
}
