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
import { validateServerUrl, type ServerUrlResult } from './server-url';
import { SERVER_CHANGED_MESSAGE } from './sync-manager';
import type { AttachmentIssue } from './types';

/** Longest path or link shown in the issues list, in code points. */
const DISPLAY_MAX = 120;

/**
 * A path or link cut to `max` code points for the issues list: the start, an
 * ellipsis, and the end (which holds the file name). The full value stays in the
 * row's tooltip.
 */
export function shortenForDisplay(text: string, max = DISPLAY_MAX): string {
	const cps = Array.from(text);
	if (cps.length <= max) return text;
	const tail = Math.ceil((max - 1) * 2 / 3);
	const head = max - 1 - tail;
	return [...cps.slice(0, head), '…', ...cps.slice(cps.length - tail)].join('');
}

/** Reasons whose text does not depend on a server limit. */
const ATTACHMENT_REASON_TEXT: Record<Exclude<AttachmentIssue['reason'], 'too-large' | 'too-many-files'>, string> = {
	missing: 'not found in this vault',
	'storage-limit': 'UCT storage is full',
	'upload-failed': 'upload failed, will retry on the next sync',
	'link-too-long': 'name or link too long to sync',
	'note-too-large-for-files': 'note too large to send with its images and files; they were not sent',
	'server-busy': 'UCT is busy and is not taking images and files right now; will keep retrying',
	'waiting-for-index': 'waiting for Obsidian to index this note; its changes will sync once it has',
	'pushed-without-files': 'pushed without its images and files; Obsidian has not indexed it yet',
	'check-failing':
		'UCT has not accepted images and files for several syncs; notes still sync, and files will follow once it does',
};

function megabytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : Math.round(mb * 10) / 10} MB`;
}

/**
 * The text Settings shows for one issue. Limits come from the server's own answer
 * (`issue.limit`), never a number written here, so a changed server cap is described
 * truthfully (final review I3, M2). A server sentence, when there is one, wins.
 */
export function issueText(issue: AttachmentIssue): string {
	if (issue.message) return issue.message;
	if (issue.reason === 'too-large') {
		return issue.limit ? `larger than ${megabytes(issue.limit)}` : 'larger than UCT accepts';
	}
	if (issue.reason === 'too-many-files') {
		return issue.limit
			? `more than ${issue.limit} images and files in one note; the rest were not sent`
			: 'too many images and files in one note; the rest were not sent';
	}
	return ATTACHMENT_REASON_TEXT[issue.reason];
}

/** Most issue rows Settings renders; the rest are counted (final review M6). */
const MAX_ISSUE_ROWS = 200;

/** The issues Settings lists: the first MAX_ISSUE_ROWS, and how many more there are, so
 * a vault with thousands of broken links never renders thousands of rows. */
export function visibleIssues(
	issues: AttachmentIssue[], max = MAX_ISSUE_ROWS,
): { shown: AttachmentIssue[]; more: number } {
	return { shown: issues.slice(0, max), more: Math.max(0, issues.length - max) };
}

/**
 * Save a Server URL the member committed (blur or Enter): validated and normalized,
 * saved only if valid and only if it changed.
 */
export async function commitServerUrl(
	plugin: { data: { serverUrl: string }; saveData(data: unknown): Promise<void> },
	value: string,
): Promise<ServerUrlResult> {
	const result = validateServerUrl(value);
	if (result.ok && result.url !== plugin.data.serverUrl) {
		plugin.data.serverUrl = result.url;
		await plugin.saveData(plugin.data);
	}
	return result;
}

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

		const urlSetting = new Setting(containerEl)
			.setName('Server URL')
			.setDesc('Your UCT Intelligence dashboard origin. Leave the default unless a UCT team member told you otherwise.');
		// Created once and reused across changes, so the message never stacks.
		const errorEl = urlSetting.descEl.createDiv({ cls: 'uct-notebook-sync-error' });
		errorEl.hide();
		const showUrlResult = (result: ServerUrlResult): void => {
			if (result.ok) {
				errorEl.setText('');
				errorEl.hide();
			} else {
				errorEl.setText(result.message);
				errorEl.show();
			}
		};
		urlSetting.addText((text) => {
			// Typing only validates. The value is SAVED on blur or Enter (final review
			// I6): saving every valid keystroke stored each intermediate origin, so a sync
			// mid-edit could go to a half-typed address.
			text
				.setPlaceholder('https://uctintelligence.com')
				.setValue(data.serverUrl)
				.onChange((value) => showUrlResult(validateServerUrl(value)));
			const commit = async (): Promise<void> => {
				const result = await commitServerUrl(this.plugin, text.getValue());
				showUrlResult(result);
				if (result.ok) this.display();
			};
			text.inputEl.addEventListener('blur', () => { void commit(); });
			text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') void commit();
			});
		});

		if (data.deviceToken) {
			this.renderConnected(containerEl);
		} else {
			this.renderDisconnected(containerEl);
		}

		new Setting(containerEl)
			.setName('Sync images and files')
			.setDesc(
				'Send the images and files your notes use' +
				(data.attachmentServer ? ` (up to ${megabytes(data.attachmentServer.maxBytes)} each)` : '') +
				'. Turn off to send note text only.',
			)
			.addToggle((toggle) =>
				toggle.setValue(data.syncAttachments).onChange(async (value) => {
					data.syncAttachments = value;
					await this.plugin.saveData(data);
				}),
			);

		this.renderTooLarge(containerEl);
		this.renderAttachmentIssues(containerEl);
	}

	/** Re-render after a sync finishes, but only while the tab is on screen, so the
	 * issues list never shows the previous run's results (review M5). */
	refreshIfOpen(): void {
		if (this.containerEl.isShown()) this.display();
	}

	private renderAttachmentIssues(containerEl: HTMLElement): void {
		const issues = this.plugin.data.attachmentIssues;
		if (issues.length === 0) return;
		new Setting(containerEl)
			.setName(`Images and files that could not sync (${issues.length})`)
			.setHeading();
		const list = containerEl.createEl('ul');
		const { shown, more } = visibleIssues(issues);
		for (const issue of shown) {
			const text = issueText(issue);
			// a run-wide issue (server busy) names no file
			list.createEl('li', issue.path
				? { text: `${shortenForDisplay(issue.path)}: ${text}`, attr: { title: issue.path } }
				: { text });
		}
		if (more > 0) list.createEl('li', { text: `+${more} more` });
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
					data.tokenOrigin = null;
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
		if (data.tokenOrigin !== null && data.tokenOrigin !== data.serverUrl) {
			containerEl.createEl('p', {
				text: `${SERVER_CHANGED_MESSAGE}: this connection belongs to ${data.tokenOrigin}.`,
				cls: 'uct-notebook-sync-error',
			});
		} else if (data.lastSyncError) {
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
				'These notes are too large to send (over 2 MB) or to store once converted, so they are skipped rather than ' +
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
