/**
 * Test-only stand-in for the real `obsidian` package. The published
 * `obsidian` npm package is TYPES ONLY (`"main": ""`) — it has no runtime
 * JavaScript at all, so Vite/Vitest cannot resolve it as a real module even
 * under `vi.mock`. `vitest.config.ts` aliases the `obsidian` specifier to
 * this file for tests only; production code never sees it (esbuild.config.mjs
 * marks `obsidian` external — the real Obsidian app supplies it at runtime).
 */
import { vi } from 'vitest';

export const requestUrl = vi.fn();

/** Test stand-in for Obsidian's own `TFile`; production uses the real one. */
export class TFile { path = ''; extension = ''; basename = ''; stat = { mtime: 0, size: 0, ctime: 0 }; }

/** Test stand-in for Obsidian's own `parseLinktext`; production uses the real one. */
export function parseLinktext(linktext: string) { const i = linktext.indexOf('#'); return i < 0 ? { path: linktext, subpath: '' } : { path: linktext.slice(0, i), subpath: linktext.slice(i) }; }

/** Every Notice shown, in order. Tests clear it in beforeEach. */
export const notices: string[] = [];

/** Test stand-in for Obsidian's `Notice`: records the message. */
export class Notice {
	constructor(message: string) { notices.push(message); }
	hide(): void {}
}

/**
 * Minimal `Plugin`: just what main.ts touches. loadData/saveData keep one
 * in-memory blob and count saves; the registration calls are no-ops.
 */
export class Plugin {
	app: any = {
		vault: {
			getName: () => 'Test Vault',
			getMarkdownFiles: () => [],
			getAbstractFileByPath: () => null,
			cachedRead: async () => '',
		},
		metadataCache: {},
	};
	manifest: any = { id: 'uct-notebook-sync' };
	stored: unknown = null;
	saveCalls: unknown[] = [];
	constructor(app?: unknown, manifest?: unknown) {
		if (app) this.app = app;
		if (manifest) this.manifest = manifest;
	}
	async loadData(): Promise<unknown> { return this.stored; }
	async saveData(data: unknown): Promise<void> {
		this.stored = JSON.parse(JSON.stringify(data));
		this.saveCalls.push(this.stored);
	}
	addCommand(_cmd: unknown): void {}
	addRibbonIcon(_icon: string, _title: string, _cb: () => void): void {}
	addSettingTab(_tab: unknown): void {}
	registerInterval(_id: number): number { return 0; }
	registerEvent(_ref: unknown): void {}
}

export class PluginSettingTab {
	containerEl: any = {};
	constructor(public app: unknown, public plugin: unknown) {}
}

export class Setting {
	constructor(_el: unknown) {}
}
