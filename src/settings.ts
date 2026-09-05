/**
 * Settings tab: server URL, connect-code redemption, manual sync, and a
 * visible list of notes the server has permanently refused (too large) —
 * per the task's own hard requirement, a too-large note must be SURFACED,
 * not silently retried forever nor silently dropped. See sync-plan.ts for
 * the logic that decides which notes land in that list.
 */
import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type UctNotebookSyncPlugin from './main';

export class UctNotebookSyncSettingTab extends PluginSettingTab {
	private connectCode = '';

	constructor(app: App, private readonly plugin: UctNotebookSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const data = this.plugin.data;

		// ⛔ NO leading heading here. Two review rules meet at this line: a
		// heading must be built with `Setting(...).setHeading()` rather than a
		// raw `createEl('h2')`, AND a settings heading must not repeat the
		// plugin name — which is the only thing a heading in this position
		// could say, since Obsidian already titles the tab "UCT Notebook Sync".
		// The description below carries the information; the heading carried none.
		containerEl.createEl('p', {
			text:
				'One-way sync: this vault’s markdown notes are pushed into your ' +
				'UCT Intelligence Notebook. Nothing is ever written back to this vault.',
		});

		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('Your UCT Intelligence dashboard origin. Leave the default unless a UCT team member told you otherwise.')
			.addText((text) =>
				text
					.setPlaceholder('https://uctintelligence.com')
					.setValue(data.serverUrl)
					.onChange(async (value) => {
						const trimmed = value.trim().replace(/\/+$/, '');
						data.serverUrl = trimmed || data.serverUrl;
						await this.plugin.saveData(data);
					}),
			);

		if (data.deviceToken) {
			this.renderConnected(containerEl);
		} else {
			this.renderDisconnected(containerEl);
		}

		this.renderTooLarge(containerEl);
	}

	private renderConnected(containerEl: HTMLElement): void {
		const data = this.plugin.data;
		new Setting(containerEl)
			.setName('Connection')
			.setDesc(`Connected as "${data.connectedLabel ?? data.vaultId}".`)
			.addButton((btn) =>
				btn.setButtonText('Sync now').setCta().onClick(async () => {
					await this.plugin.runManualSync();
					this.display();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText('Forget connection (local only)').setWarning().onClick(async () => {
					// This does NOT call the server — disconnecting the
					// server-side device token happens in the dashboard's
					// Settings page (DELETE /obsidian), which is also the
					// only place that revokes it. This button only clears
					// what THIS install remembers, e.g. after moving to a
					// fresh device where reconnecting is easier than
					// tracking down the old token.
					data.deviceToken = null;
					data.connectedLabel = null;
					data.connectedAt = null;
					await this.plugin.saveData(data);
					new Notice('Forgot this connection locally. Reconnect below, or from the dashboard.');
					this.display();
				}),
			);

		if (data.lastSyncAt) {
			containerEl.createEl('p', {
				text: `Last sync: ${new Date(data.lastSyncAt).toLocaleString()}`,
				cls: 'setting-item-description',
			});
		}
		if (data.lastSyncError) {
			containerEl.createEl('p', {
				text: `Last sync error: ${data.lastSyncError}`,
				cls: 'uct-notebook-sync-error',
			});
		}
	}

	private renderDisconnected(containerEl: HTMLElement): void {
		containerEl.createEl('p', {
			text:
				'Generate a connect code from your UCT Intelligence dashboard ' +
				'(Journal → Settings → Notebook Connectors → Obsidian), then paste it below. ' +
				'The code works once and expires in a few minutes.',
		});
		new Setting(containerEl).setName('Connect code').addText((text) =>
			text.setPlaceholder('Paste code here').onChange((value) => {
				this.connectCode = value.trim();
			}),
		);
		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText('Connect')
				.setCta()
				.onClick(async () => {
					if (!this.connectCode) {
						new Notice('Paste a connect code first.');
						return;
					}
					btn.setDisabled(true).setButtonText('Connecting…');
					const result = await this.plugin.redeemConnectCode(this.connectCode);
					if (!result.ok) {
						btn.setDisabled(false).setButtonText('Connect');
						new Notice(`Could not connect: ${result.message}`);
						return;
					}
					this.connectCode = '';
					// ⛔ Connecting a vault MEANS "bring this vault into UCT".
					// This notice previously said the vault "is now syncing"
					// while nothing had been started — the member had to find
					// "Sync now" themselves, so the copy promised a run that
					// was not happening. Do the first sync here so the
					// sentence is true, and report what actually landed.
					btn.setButtonText('Importing…');
					const summary = await this.plugin.runManualSync();
					btn.setDisabled(false).setButtonText('Connect');
					const vault = this.plugin.app.vault.getName();
					if (summary.ok) {
						const skipped = summary.tooLarge.length;
						new Notice(
							`Connected. ${summary.pushed} note${summary.pushed === 1 ? '' : 's'} ` +
							`from "${vault}" sent to UCT Notebook` +
							(skipped ? ` — ${skipped} too large to send (listed below).` : '.'),
						);
					} else {
						// Connected, but the first import did not complete. Say
						// exactly that rather than claiming the vault is synced.
						new Notice(
							`Connected, but the first import did not finish: ${summary.error ?? 'unknown error'}. ` +
							'Use "Sync now" to retry.',
						);
					}
					this.display();
				}),
		);
	}

	private renderTooLarge(containerEl: HTMLElement): void {
		const data = this.plugin.data;
		const tooLarge = Object.entries(data.files)
			.filter(([, state]) => state.tooLarge)
			.map(([path]) => path)
			.sort();
		if (tooLarge.length === 0) return;

		new Setting(containerEl)
			.setName(`Notes that could not sync (${tooLarge.length})`)
			.setHeading();
		containerEl.createEl('p', {
			text:
				'These notes are too large to store once converted, so they are skipped rather than ' +
				'retried on every sync. Shorten a note and it will be retried automatically on the next sync.',
		});
		const list = containerEl.createEl('ul');
		for (const path of tooLarge) {
			list.createEl('li', { text: path });
		}
		new Setting(containerEl)
			.setDesc('Force every note above back into the next sync attempt, even if unchanged.')
			.addButton((btn) =>
				btn.setButtonText('Retry all now').onClick(async () => {
					for (const path of tooLarge) {
						delete data.files[path];
					}
					await this.plugin.saveData(data);
					await this.plugin.runManualSync();
					this.display();
				}),
			);
	}
}
