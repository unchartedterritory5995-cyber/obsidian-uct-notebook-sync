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
import type { App, CachedMetadata, EmbedCache } from 'obsidian';
import type { VaultFileRef, VaultSource } from './sync-manager';
import { markdownTarget, type RawLinkRef, type ResolvedFile } from './attachment-refs';

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

/** `[[target|` closing the text just before an embed. It is matched against the embed's
 * own LINE only (split at `\n`), so a target never runs across a blank line.
 *
 * ⛔ The whole link is sent only where the server splits it back into the image and the
 * chip (`_ALIAS_EMBED_RE` in providers/obsidian.py); a whole link it does not split
 * claims the text and the image is lost. So every character class here is a SUBSET of
 * the server's: on one line its `_WIKI_TARGET` excludes `]`, `|` and the stop `[[` (every
 * other `_WIKI_STOP`, the `<` one included, starts at a `\n`). This also excludes any
 * `[`, a `<` and a lone `\r` (a line break to Obsidian's editor): stricter is safe, a
 * doubt sends no ref, which is 0.2.0's behaviour. A one-off differential fuzz against the
 * server regex in fix round 1 (M1) found no original the plugin accepts and the server does
 * not split; it is not kept as a test. */
const ALIAS_HEAD_RE = /\[\[([^[\]|<\r]+)\|$/;

/** An embed the server splits back out of a whole-link original, a `![[...]]` its
 * `_WIKI_EMBED` reads, with the same subset rule as ALIAS_HEAD_RE. A markdown image
 * (`![](img.png)`) is NOT split by the server: sent as a whole link, the image would be
 * lost (fix round 1, I1). */
const WIKI_EMBED_RE = /^!\[\[[^[\]|<\r\n]+(?:\|[^[\]<\r\n]+)?\]\]$/;

/**
 * The link whose WHOLE alias is this embed, `[[q.pdf|![[img.png]]]]`, read from the
 * note body at the embed's own cached position (issue #2). Obsidian 1.13.7 caches only
 * the embed for that text and no link entry at all, so the file the link names would
 * otherwise never be sent. Anchoring on a cached embed keeps code spans and fences out
 * for free: Obsidian never caches an embed in code.
 *
 * Only an alias that is EXACTLY the embed counts: `[[q.pdf| x ![[img.png]]]]` is not
 * read (the issue's shape, nothing wider). `![[q.pdf|![[img.png]]]]`, an embed whose
 * alias is an embed, is not a link and is left alone. Returns the offset of the `[[`
 * with the ref, or null.
 */
function embedAliasLink(body: string, e: EmbedCache): { start: number; ref: RawLinkRef } | null {
	const start = e.position?.start?.offset;
	const end = e.position?.end?.offset;
	if (typeof start !== 'number' || typeof end !== 'number') return null;
	if (!WIKI_EMBED_RE.test(e.original)) return null;
	// A cache older than the body: its offsets no longer point at this embed.
	if (body.slice(start, end) !== e.original) return null;
	if (body.slice(end, end + 2) !== ']]') return null;
	const lineStart = body.lastIndexOf('\n', start - 1) + 1;
	const m = ALIAS_HEAD_RE.exec(body.slice(lineStart, start));
	if (m === null) return null;
	const target = m[1] ?? '';
	if (!target.trim()) return null;
	const linkStart = start - m[0].length;
	if (body[linkStart - 1] === '!') return null;
	return { start: linkStart, ref: { original: body.slice(linkStart, end + 2), linkpath: target, embed: false } };
}

export class ObsidianVaultSource implements VaultSource {
	/** Set once a wait for the metadata cache has ended, by Obsidian's `'resolved'`
	 * event or by the timeout. From then on a note whose cache is still null is read as
	 * "no refs" at once: Obsidian does not re-emit `'resolved'` until a file changes,
	 * so waiting again would cost the full timeout on every sync (review M3). Such a
	 * note re-pushes once with its refs when it is indexed. */
	private indexingSettled = false;

	/** Pending metadata waits, so unloading the plugin can end them (final review M3):
	 * each removes its 'resolved' listener and its timer as it ends. */
	private readonly waits = new Set<() => void>();

	/** End every pending metadata wait now. Called from the plugin's `onunload`. */
	cancelWaits(): void {
		for (const finish of [...this.waits]) finish();
	}

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
				this.waits.delete(finish);
				this.indexingSettled = true;
				clearTimeout(timer);
				cache.offref(ref);
				resolve();
			};
			const ref = cache.on('resolved', finish);
			const timer = setTimeout(finish, timeoutMs);
			this.waits.add(finish);
		});
	}

	isIndexed(notePath: string): boolean {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		return file instanceof TFile && this.app.metadataCache.getFileCache(file) !== null;
	}

	/** With the note `body`, also the link whose whole alias is an embed (issue #2),
	 * which Obsidian's cache does not report; without it, the cache's refs only. */
	listRawRefs(notePath: string, body?: string): RawLinkRef[] {
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
		if (body === undefined) return out;
		// A future Obsidian that caches the link itself is not sent it twice.
		const linkStarts = new Set<number>();
		for (const l of meta.links ?? []) {
			const at = l.position?.start?.offset;
			if (typeof at === 'number') linkStarts.add(at);
		}
		for (const e of meta.embeds ?? []) {
			const hit = embedAliasLink(body, e);
			if (hit === null || linkStarts.has(hit.start)) continue;
			add(hit.ref.original, hit.ref.linkpath, false);
		}
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

	resolveRef(raw: RawLinkRef, sourcePath: string): ResolvedFile | null {
		const hit = this.resolveLink(raw.linkpath, sourcePath);
		if (hit !== null) return hit;
		// A markdown destination as the server reads it (`x.png?raw=1` names `x.png`),
		// asked of Obsidian AS IS: it is already decoded once, so it never goes back
		// through resolveLink's `%` retry (review N1, N2).
		const target = markdownTarget(raw);
		if (!target || target === raw.linkpath.trim()) return null;
		const dest = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
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
