/**
 * The one concrete `VaultSource`, a thin adapter over Obsidian's real `Vault` and
 * `MetadataCache` APIs. `sync-manager.test.ts` covers every sync decision through
 * a fake `VaultSource`; `vault-source.test.ts` covers this adapter against a fake
 * `App`.
 *
 * Link resolution is Obsidian's own (`getFirstLinkpathDest`): shortest path,
 * same-folder-first and the attachment folder setting are never reimplemented here.
 */
import { parseLinktext, TFile } from 'obsidian';
import type { App, CachedMetadata } from 'obsidian';
import type { VaultFileRef, VaultSource } from './sync-manager';
import type { RawLinkRef, ResolvedFile } from './attachment-refs';

function toResolved(file: TFile): ResolvedFile {
	return { path: file.path, extension: file.extension, size: file.stat.size, mtime: file.stat.mtime };
}

/**
 * `dest` is the file `text` names EXACTLY: its path, lowercased, equals the text
 * (a folder-qualified link from the vault root) or ends in `/` + the text, or its
 * name equals it. The server's `_ends_at` (`form == want or form.endswith("/" + want)`),
 * the rule `providers/obsidian.py::_resolve_in` and `adapters/obsidian.js::resolveTarget`
 * apply to a target holding `#` (Plan C Task 4 fix round 1, ruling 1). Both sides are
 * NFC-normalised first: a macOS vault can hold an NFD file name that the member's
 * link text spells in NFC (review M6).
 */
function namesExactly(dest: TFile, text: string): boolean {
	const fold = (s: string): string => s.normalize('NFC').toLowerCase();
	const want = fold(text);
	const path = fold(dest.path);
	return path === want || path.endsWith('/' + want) || fold(dest.name) === want;
}

export class ObsidianVaultSource implements VaultSource {
	/** Set once a wait for the metadata cache has ended, by Obsidian's `'resolved'`
	 * event or by the timeout. From then on a note whose cache is still null is read as
	 * "no refs" at once: Obsidian does not re-emit `'resolved'` until a file changes,
	 * so waiting again would cost the full timeout on every sync (review M3). Such a
	 * note re-pushes once with its refs when it is indexed. */
	private indexingSettled = false;

	constructor(private readonly app: App) {}

	async listMarkdownFiles(): Promise<VaultFileRef[]> {
		return this.app.vault.getMarkdownFiles().map((f: TFile) => ({
			path: f.path,
			mtime: f.stat.mtime,
		}));
	}

	async readFile(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		// `instanceof TFile` rather than `as TFile` behind an `'extension' in
		// file` duck-check: a folder that happened to carry an `extension`
		// property would have satisfied the old guard and been handed to
		// `cachedRead` as if it were a file.
		if (!(file instanceof TFile)) {
			throw new Error(`File not found or not readable: ${path}`);
		}
		return this.app.vault.cachedRead(file);
	}

	async whenMetadataReady(timeoutMs: number): Promise<void> {
		const cache = this.app.metadataCache;
		if (this.indexingSettled) return;
		if (this.app.vault.getMarkdownFiles().every((f) => cache.getFileCache(f) !== null)) return;
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				this.indexingSettled = true;
				clearTimeout(timer);
				cache.offref(ref);
				resolve();
			};
			const ref = cache.on('resolved', finish);
			const timer = setTimeout(finish, timeoutMs);
		});
	}

	listRawRefs(notePath: string): RawLinkRef[] {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return [];
		const meta: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
		if (meta === null) return [];
		const out: RawLinkRef[] = [];
		const seen = new Set<string>();
		const add = (original: string, linkpath: string, embed: boolean): void => {
			if (seen.has(original)) return;
			seen.add(original);
			out.push({ original, linkpath, embed });
		};
		for (const e of meta.embeds ?? []) add(e.original, e.link, true);
		for (const l of meta.links ?? []) add(l.original, l.link, false);
		return out;
	}

	resolveLink(linkpath: string, sourcePath: string): ResolvedFile | null {
		const cache = this.app.metadataCache;
		// A `#` is an anchor OR part of a file NAME (`my chart #1 (v2).png`): the full
		// text is asked first, and kept only when it names the file exactly. ⛔ Without
		// this, that embed asks for `my chart `, finds nothing, and the server shows a
		// pending note link where the member's image was (Task 4 review I1).
		const text = linkpath.trim();
		if (text.includes('#')) {
			const hit = cache.getFirstLinkpathDest(text, sourcePath);
			if (hit instanceof TFile && namesExactly(hit, text)) return toResolved(hit);
		}
		const path = parseLinktext(text).path.trim();
		let dest = cache.getFirstLinkpathDest(path, sourcePath);
		if (dest === null && path.includes('%')) {
			try {
				dest = cache.getFirstLinkpathDest(decodeURIComponent(path), sourcePath);
			} catch {
				// a malformed escape: the link stays unresolved
			}
		}
		return dest instanceof TFile ? toResolved(dest) : null;
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found or not readable: ${path}`);
		}
		return this.app.vault.readBinary(file);
	}
}
