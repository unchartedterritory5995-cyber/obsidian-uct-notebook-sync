/**
 * Orchestrates one sync run: scan -> plan -> batch -> push -> manifest ->
 * persist. Depends only on the small `Transport` and `VaultSource`
 * interfaces (both injected), never on the `obsidian` module directly — the
 * whole class is unit-testable with stub implementations of both and no
 * network, no vault, no live server.
 *
 * ── The two-phase push, and why ─────────────────────────────────────────
 *
 * Phase 1 pushes zero or more `{notes: [...], final: false}` batches — pure
 * content, no manifest. Phase 2, run only after every phase-1 batch has
 * succeeded, sends exactly ONE `{notes: [], manifest: [...], final: true}`
 * call. Splitting it this way (rather than attaching the manifest to the
 * last content batch) means the manifest never has to "hope" a same-call
 * note landed — by the time phase 2 runs, everything phase 1 pushed is
 * already durably staged, so referencing any of those paths satisfies the
 * server's own manifest-integrity check
 * (`obsidian_staging.ingest_batch`'s I3 guard: a manifest path must have
 * been staged EITHER in this call OR an earlier one — see that module's own
 * docstring and its "staged in an earlier batch" test).
 *
 * ── What stops a note the server just rejected from re-appearing next run ──
 *
 * `finalizeManifest` strips a path THIS run's ingest calls reported
 * `tooLarge` before phase 2 ever sends it — but ONLY when that path has
 * NEVER been successfully staged before (`plan.neverStagedPaths`). A path
 * that grew past the ceiling AFTER syncing fine once is left in the
 * manifest regardless, so growing one note never makes an unrelated,
 * already-imported note look deleted (see sync-plan.ts's own docstring for
 * the full reasoning — this is the subtler half of the "never dishonestly
 * name an un-staged path" rule, not a contradiction of it).
 *
 * ── Auth failure handling (gotcha #7 — never loop on a dead token) ───────
 *
 * A 401 from ANY ingest/redeem call clears the stored `deviceToken` (never
 * `vaultId` — that must survive so a fresh redeem still ROTATES the same
 * device row rather than minting an orphaned second one) and reports
 * `needsReconnect: true`. The caller (main.ts / the settings tab) is
 * responsible for telling the member to reconnect; this class never retries
 * a 401 itself and never schedules a background retry loop against a token
 * it just learned is dead.
 */
import {
	buildBatches, DEFAULT_BATCH_OPTIONS, exceedsIngestCap, type BatchOptions,
} from './batching';

/** Runs an unindexed note that last carried refs is deferred before its text is pushed
 * without the list (review N1). */
export const MAX_DEFERRED_RUNS = 3;

export const SERVER_CHANGED_MESSAGE = 'Server address changed — reconnect to sync';
export const STOPPED_MESSAGE = 'Sync stopped: the plugin was turned off or Obsidian closed.';
import { noteContentHash } from './attachment-refs';
import { prepareAttachments } from './attachment-sync';
import { applySyncResult, finalizeManifest, planSync } from './sync-plan';
import type { NoteInput, PluginData, ScannedFile } from './types';
import type { Transport } from './api-client';
import type { RawLinkRef, ResolvedFile } from './attachment-refs';

export interface VaultFileRef {
	path: string;
	/** Epoch milliseconds — informational only, feeds `updated_at`. */
	mtime: number;
}

/** What `sync-manager.ts` needs from a vault — deliberately narrow so a test
 * fake can implement it in a few lines with no `obsidian` import at all. */
export interface VaultSource {
	listMarkdownFiles(): Promise<VaultFileRef[]>;
	readFile(path: string): Promise<string>;
	/** Resolves once Obsidian has indexed every markdown file, or after `timeoutMs`. */
	whenMetadataReady(timeoutMs: number): Promise<void>;
	/** Obsidian has a metadata cache for this note (it has been indexed). */
	isIndexed(notePath: string): boolean;
	/** A note's embeds and links as Obsidian's cache records them; `[]` while unindexed. */
	listRawRefs(notePath: string): RawLinkRef[];
	/** The vault file a link names, by Obsidian's own resolver, or null. */
	resolveLink(linkpath: string, sourcePath: string): ResolvedFile | null;
	/** `resolveLink(raw.linkpath)`, then, for a markdown-form ref only, one retry with
	 * the destination cut at `?`/`#` and decoded once. What Task 10 calls per ref. */
	resolveRef(raw: RawLinkRef, sourcePath: string): ResolvedFile | null;
	readBinary(path: string): Promise<ArrayBuffer>;
}

export interface SyncManagerDeps {
	transport: Transport;
	vaultSource: VaultSource;
	getData: () => PluginData;
	saveData: (data: PluginData) => Promise<void>;
	/** Injectable clock for deterministic tests. */
	now?: () => string;
	/** Milliseconds, for the attachment upload budget; injectable for tests. */
	clock?: () => number;
	/** A progress message for the member (main.ts shows it as a Notice). */
	onProgress?: (message: string) => void;
	batchOptions?: BatchOptions;
}

export interface SyncSummary {
	ok: boolean;
	scanned: number;
	pushed: number;
	skippedUnchanged: number;
	tooLarge: string[];
	skippedTooLargeUnchanged: string[];
	deletedLocally: string[];
	manifestSent: boolean;
	needsReconnect: boolean;
	/** The server takes attachments (plugin 0.2.0 protocol); false = text-only run. */
	attachmentsSupported: boolean;
	/** Blobs uploaded this run. */
	attachmentsSent: number;
	/** Images and files that could not come over (listed in Settings). */
	attachmentIssues: number;
	error?: string;
}

function isoNow(): string {
	return new Date().toISOString();
}

export class SyncManager {
	private aborted = false;

	constructor(private readonly deps: SyncManagerDeps) {}

	/** The plugin is unloading: a running sync sends no further request (final review
	 * M3). It stops at its next checkpoint, before a batch or the manifest; a note
	 * batch already in flight completes. */
	abort(): void {
		this.aborted = true;
	}

	async runSync(): Promise<SyncSummary> {
		const data = this.deps.getData();
		const empty = (overrides: Partial<SyncSummary>): SyncSummary => ({
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
			...overrides,
		});

		if (!data.deviceToken) {
			return empty({
				needsReconnect: true,
				error: 'Not connected to UCT Notebook. Paste a connect code in Settings first.',
			});
		}
		// Captured into a local so TypeScript's narrowing (and our own
		// reasoning) survives the `await`s below — `data.deviceToken` itself
		// stays `string | null` since `fail()` may null it out mid-run.
		const deviceToken: string = data.deviceToken;

		// ⛔ The token goes only to the origin it was redeemed against. A Server URL edited
		// to a typo or to an address someone else supplied would otherwise receive the
		// member's bearer token and their notes (final review I6). Kept, not cleared:
		// changing the field back makes it work again.
		if (data.tokenOrigin !== null && data.tokenOrigin !== data.serverUrl) {
			data.lastSyncError = SERVER_CHANGED_MESSAGE;
			await this.deps.saveData(data);
			return empty({ error: SERVER_CHANGED_MESSAGE });
		}
		// Settings are read ONCE per run (final review M4): an edit in the Settings tab
		// while a run is going applies to the next run, never half of this one (a toggle
		// flipped mid-hash would mix `off` and `ok` refs; a URL edited mid-run would point
		// the later batches and the manifest elsewhere).
		const serverUrl = data.serverUrl;
		const syncAttachments = data.syncAttachments;

		const now = (this.deps.now ?? isoNow)();
		const files = await this.deps.vaultSource.listMarkdownFiles();

		// Phase 0: the images and files the notes use. Only an expired token fails
		// the run; every other attachment problem is an issue, never a failed sync.
		const att = await prepareAttachments(
			{
				transport: this.deps.transport,
				vaultSource: this.deps.vaultSource,
				data,
				serverUrl,
				token: deviceToken,
				syncAttachments,
				clock: this.deps.clock,
				saveProgress: () => this.deps.saveData(data),
				onProgress: this.deps.onProgress,
				shouldStop: () => this.aborted,
			},
			files.map((f) => f.path),
		);
		if (att.authExpired) {
			const message = att.failMessage ?? 'Not authenticated';
			data.deviceToken = null;
			data.lastSyncError = message;
			await this.deps.saveData(data);
			return empty({ needsReconnect: true, error: message });
		}
		data.attachmentIssues = [...att.issues]; // replaced each run

		const scanned: ScannedFile[] = [];
		/** Deferred this run -> its consecutive deferred-run count. */
		const deferred = new Map<string, number>();
		/** Pushed without its list after MAX_DEFERRED_RUNS deferrals. */
		const pushedBare = new Set<string>();
		for (const f of files) {
			const body = await this.deps.vaultSource.readFile(f.path);
			let refs = att.refsByNote.get(f.path) ?? null;
			const updatedAt = new Date(f.mtime).toISOString();
			// Not indexed yet (null on a supported run), and its last push carried a
			// list: DEFER it. Pushed list-less, the server would store NULL for it, show
			// its images and files as unavailable and GC their blobs until the next run.
			// Keeping the prior hash leaves it unchanged (and still manifested) this run;
			// it pushes, with its list, once Obsidian has indexed it. The deferral is
			// visible from its first run and BOUNDED (review N1): after
			// MAX_DEFERRED_RUNS in a row the text goes out without the list, and the
			// list follows on the first indexed run. The count lives in `data.files`,
			// so it survives a restart.
			const prior = data.files[f.path];
			// Not reached by this run's hashing budget: its last pushed state stands if it
			// carried a list (held, like a deferral, but with no count or issue: the next
			// run carries on); otherwise its text goes out now and its list next run.
			if (att.pending.has(f.path)) {
				if (prior?.hadRefs && !prior.tooLarge) {
					scanned.push({ path: f.path, hash: prior.hash, updatedAt, body, attachments: null });
					continue;
				}
			}
			const unindexed = att.supported && refs === null && !att.pending.has(f.path);
			if (unindexed && prior?.hadRefs && !prior.tooLarge) {
				const runs = (prior.deferredRuns ?? 0) + 1;
				if (runs <= MAX_DEFERRED_RUNS) {
					deferred.set(f.path, runs);
					data.attachmentIssues.push({ path: f.path, reason: 'waiting-for-index', size: 0 });
					scanned.push({ path: f.path, hash: prior.hash, updatedAt, body, attachments: null });
					continue;
				}
				pushedBare.add(f.path);
				data.attachmentIssues.push({ path: f.path, reason: 'pushed-without-files', size: 0 });
			} else if (unindexed && prior?.listlessPush) {
				data.attachmentIssues.push({ path: f.path, reason: 'pushed-without-files', size: 0 });
			}
			// A note over the batch budget already goes alone. If its refs would take even
			// that single request past the server's 2 MB cap, the server would refuse the
			// batch on every run and block every later one: send the text without the list
			// (the server shows its images and files as unavailable) and say so in
			// Settings (review M3). A body alone over the cap is refused as in 0.1.x.
			if (refs !== null && refs.length > 0) {
				const bare: NoteInput = { vault_path: f.path, content_hash: '0'.repeat(64), body_md: body, updated_at: updatedAt };
				// (a body over the cap on its own is not sent at all; see below)
				if (!exceedsIngestCap(bare) && exceedsIngestCap({ ...bare, attachments: refs })) {
					refs = null;
					data.attachmentIssues.push({ path: f.path, reason: 'note-too-large-for-files', size: 0 });
				}
			}
			scanned.push({
				path: f.path,
				// With no refs this is exactly 0.1.x's sha256Hex(body).
				hash: noteContentHash(body, refs),
				updatedAt,
				body,
				attachments: refs,
			});
		}

		const plan = planSync(scanned, data.files);
		const tooLargeThisRun = new Set<string>();
		// A note whose request alone is over the server's 2 MB ingest cap would be
		// refused with its whole batch, on every run, and stall the vault there. It is
		// not sent: it is recorded too large exactly as a server `tooLarge` verdict is,
		// so Settings lists it, the run goes on with every other note, and it is retried
		// only once its content changes (sync-plan's tooLarge rule).
		const sendable: NoteInput[] = [];
		for (const note of plan.toPush) {
			if (exceedsIngestCap(note)) tooLargeThisRun.add(note.vault_path);
			else sendable.push(note);
		}
		plan.toPush = sendable;
		// Counted under `tooLarge`, never as "unchanged" (review N3).
		const notSentTooLarge = tooLargeThisRun.size;
		const batches = buildBatches(plan.toPush, this.deps.batchOptions ?? DEFAULT_BATCH_OPTIONS);

		let pushed = 0;

		// Persists `lastSyncError` (and clears a dead token on a 401) BEFORE
		// returning — a member reopening Settings after Obsidian restarts
		// must still see why the last run failed, not just a silently-stale
		// `lastSyncAt`.
		const fail = async (message: string, authExpired: boolean): Promise<SyncSummary> => {
			if (authExpired) data.deviceToken = null;
			data.lastSyncError = message;
			await this.deps.saveData(data);
			return empty({
				scanned: scanned.length,
				pushed,
				skippedUnchanged: scanned.length - plan.toPush.length - notSentTooLarge,
				tooLarge: [...tooLargeThisRun],
				skippedTooLargeUnchanged: plan.skippedTooLarge,
				deletedLocally: plan.removedLocally,
				needsReconnect: authExpired,
				error: message,
			});
		};

		if (this.aborted) return fail(STOPPED_MESSAGE, false);
		for (const batch of batches) {
			if (this.aborted) return fail(STOPPED_MESSAGE, false);
			const outcome = await this.deps.transport.ingest({
				serverUrl,
				token: deviceToken,
				notes: batch,
				final: false,
			});
			if (!outcome.ok) return fail(outcome.message, outcome.authExpired);
			pushed += outcome.response.written;
			for (const p of outcome.response.tooLarge) tooLargeThisRun.add(p);
		}

		const finalManifest = finalizeManifest(plan.manifestPaths, tooLargeThisRun, plan.neverStagedPaths);
		let manifestSent = false;
		if (this.aborted) return fail(STOPPED_MESSAGE, false);
		if (finalManifest.length > 0) {
			const outcome = await this.deps.transport.ingest({
				serverUrl,
				token: deviceToken,
				notes: [],
				manifest: finalManifest,
				final: true,
			});
			if (!outcome.ok) return fail(outcome.message, outcome.authExpired);
			manifestSent = outcome.response.manifestReplaced;
		}
		// An empty `finalManifest` (nothing known-good survives this run —
		// e.g. a brand-new vault whose only file was just reported
		// tooLarge, or a genuinely empty vault) deliberately sends NOTHING
		// for phase 2 — see finalizeManifest's own docstring: an empty
		// `manifest: []` is a refused claim server-side, not a harmless
		// no-op, so silence is the only safe choice here.

		const pushedPaths = new Set(plan.toPush.map((n) => n.vault_path));
		data.files = applySyncResult(data.files, scanned, pushedPaths, tooLargeThisRun, now);
		// N1 bookkeeping: a deferred note keeps its prior state plus the run count; a note
		// pushed without its list is marked so Settings keeps saying so until it is pushed
		// with one. A normal push writes a fresh state, which resets both.
		for (const [path, runs] of deferred) {
			const state = data.files[path];
			if (state) state.deferredRuns = runs;
		}
		for (const path of pushedBare) {
			const state = data.files[path];
			if (state && pushedPaths.has(path)) state.listlessPush = true;
		}
		data.lastSyncAt = now;
		data.lastSyncError = null;
		await this.deps.saveData(data);

		return {
			ok: true,
			scanned: scanned.length,
			pushed,
			skippedUnchanged: scanned.length - plan.toPush.length - notSentTooLarge,
			tooLarge: [...tooLargeThisRun],
			skippedTooLargeUnchanged: plan.skippedTooLarge,
			deletedLocally: plan.removedLocally,
			manifestSent,
			needsReconnect: false,
			attachmentsSupported: att.supported,
			attachmentsSent: att.sent,
			attachmentIssues: data.attachmentIssues.length,
		};
	}
}
