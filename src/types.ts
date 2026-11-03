/**
 * Shared types. This file has NO dependency on the `obsidian` module and no
 * side effects — every type here is safe to import from a plain Node/vitest
 * test.
 *
 * Wire shapes below mirror the server contract EXACTLY (read before editing):
 *   - api/routers/note_sync.py — ObsidianRedeemBody, ObsidianIngestBody,
 *     ObsidianNoteItem, OBSIDIAN_INGEST_NOTES_FIELD ("notes" is pinned and
 *     required — do not rename the `notes` key on IngestRequestBody).
 *   - api/services/journal_two/note_connectors/obsidian_staging.py —
 *     ingest_batch's return shape (written/skipped/manifestReplaced/tooLarge).
 */

/** One note as pushed to `POST /obsidian/ingest`. All four fields are
 * REQUIRED by the server (`ObsidianNoteItem` has no optional/defaulted
 * field) — never omit one to "save space". */
export interface NoteInput {
	vault_path: string;
	content_hash: string;
	body_md: string;
	/** An honest, plugin-read filesystem mtime, ISO-8601. The server does
	 * NOT use this as its sync cursor (it cursors on its own server-assigned
	 * `received_at` instead) — see sync-manager.ts's module docstring. Send
	 * it honestly anyway; it is still used for display/conflict purposes. */
	updated_at: string;
	/** The note's attachment refs (plugin 0.2.0). Omitted, never `[]`-for-unknown,
	 * when the plugin sends no list (an older server, or legacy mode): the server
	 * reads an absent list as "this plugin sent none". */
	attachments?: NoteAttachmentRef[];
}

/** A ref's status, as `ObsidianAttachmentRef.status` in api/routers/note_sync.py. */
export type AttachmentStatus = 'ok' | 'too-large' | 'missing' | 'off' | 'storage-limit';

/** One attachment a note uses, resolved with Obsidian's own resolver. Mirrors
 * `ObsidianAttachmentRef` in api/routers/note_sync.py: `original` is an exact
 * substring of the note (1..2048 chars), `path` the resolved vault path, or for
 * `missing` the name as written (1..1024), and `sha256` is set exactly when
 * `status` is `ok` or `storage-limit`. */
export interface NoteAttachmentRef {
	original: string;
	embed: boolean;
	path: string;
	size: number;
	sha256: string | null;
	status: AttachmentStatus;
}

/** Body of `POST /obsidian/ingest`. `consent` is always `true` here — the
 * member already gave consent in the web dashboard's connect modal BEFORE a
 * connect code could even be minted (`ConnectBody.consent` /
 * `ObsidianConnectModal.jsx`'s required checkbox); a device token cannot
 * exist without that having happened, so there is no second consent surface
 * for this plugin to present. */
export interface IngestRequestBody {
	consent: true;
	notes: NoteInput[];
	/** The vault's COMPLETE current path list. Only ever sent together with
	 * `final: true`; never send an EMPTY array here (the server treats
	 * `manifest: [], final: true` as an explicit — and refused — claim that
	 * the vault has zero files; see obsidian_staging.py's I4 finding). Omit
	 * the field entirely (undefined) rather than sending `[]`. */
	manifest?: string[];
	final?: boolean;
}

/** Response body of a successful `POST /obsidian/ingest` call. */
export interface IngestResponse {
	written: number;
	skipped: number;
	manifestReplaced: boolean;
	/** vault_paths that were NOT staged because the converted note would
	 * exceed the server's storage ceiling. These paths are NOT "known" to
	 * the server (never written to j2_obsidian_staging) — never name one of
	 * these in a later `manifest` unless it is re-pushed successfully. */
	tooLarge: string[];
}

/** Response body of a successful `POST /obsidian/redeem` call. */
export interface RedeemResponse {
	deviceId: string;
	token: string;
	vaultId: string;
	source: { id: string; provider: string; remoteId: string };
}

/** One markdown file as read off disk, before hashing. */
export interface ScannedFile {
	path: string;
	/** sha256 hex of the CURRENT file content. */
	hash: string;
	/** ISO-8601, derived from the file's own mtime. */
	updatedAt: string;
	body: string;
	/** The note's attachment refs; `null` = send none (a server without attachment
	 * support, or a note Obsidian has not indexed yet), and the field is omitted. */
	attachments: NoteAttachmentRef[] | null;
}

/** One image or file that could not come over, shown in Settings. */
export interface AttachmentIssue {
	path: string;
	/** `link-too-long`: the ref is over the server's `original`/`path` bounds and cannot
	 * be sent. `too-many-files`: a note past the server's per-note ref cap (one issue per
	 * note). */
	reason: 'too-large' | 'missing' | 'storage-limit' | 'upload-failed' | 'link-too-long' | 'too-many-files'
		| 'note-too-large-for-files' | 'server-busy' | 'waiting-for-index' | 'pushed-without-files';
	size: number;
	/** The server's own sentence, when one failure stands for the whole run (a 403). */
	message?: string;
	/** The server limit the issue is about, as the server stated it: bytes for
	 * `too-large`, refs for `too-many-files`. Settings words its text from this. */
	limit?: number;
}

/** Everything the plugin remembers, per vault_path, between sync runs. */
export interface FileState {
	/** The content hash last seen for this path — successful OR too-large.
	 * Used to detect "nothing changed, don't re-push" (`hash` matches) vs.
	 * "the member edited this since the last too-large verdict, retry it"
	 * (`hash` differs while `tooLarge` is true). */
	hash: string;
	/** ISO-8601 timestamp of the last time this path was ACTUALLY staged
	 * (written, not skipped/too-large) server-side. */
	syncedAt: string;
	/** True when the server's most recent verdict for THIS hash was
	 * `tooLarge` — the note was never stored. See sync-plan.ts's module
	 * docstring for why a too-large note is excluded from both future
	 * pushes (until its hash changes) and the manifest (it was never
	 * actually staged, so naming it would be dishonest). */
	tooLarge?: boolean;
	/** The last push of this note carried a non-empty attachment list. While Obsidian
	 * has not indexed such a note, it is deferred rather than pushed without its list
	 * (which the server would read as "no list": notices, and its blobs GC'd). */
	hadRefs?: boolean;
	/** Consecutive runs this note was deferred while unindexed (absent = none). */
	deferredRuns?: number;
	/** Pushed without its list after too many deferrals; Settings says so until a push
	 * with a list replaces this state. */
	listlessPush?: boolean;
}

/** Everything persisted via Obsidian's `Plugin.loadData()`/`saveData()`
 * (one JSON blob at `.obsidian/plugins/uct-notebook-sync/data.json`). */
export interface PluginData {
	serverUrl: string;
	/** A random, plugin-generated identifier for THIS vault, minted once on
	 * first install and never regenerated — reconnecting (a plugin
	 * reinstall, a lost token) must reuse the SAME vaultId so the server's
	 * `UNIQUE(user_id, vault_id)` constraint ROTATES the existing device row
	 * instead of creating a second, orphaned one. */
	vaultId: string;
	deviceToken: string | null;
	/** The device label the dashboard shows for this connection (defaults
	 * to the Obsidian vault's own name at connect time). */
	connectedLabel: string | null;
	connectedAt: string | null;
	lastSyncAt: string | null;
	lastSyncError: string | null;
	/** Per-vault_path sync bookkeeping. Entries are garbage-collected the
	 * moment a path disappears from a vault scan (see applySyncResult). */
	files: Record<string, FileState>;
	/** Send the images and files notes use (plugin 0.2.0). Default on. */
	syncAttachments: boolean;
	/** Vault path -> the sha256 last computed for it, reused while mtime and size match.
	 * Entries for paths no note references any more are dropped each run. */
	attachmentHashes: Record<string, { mtime: number; size: number; sha256: string }>;
	/** What could not come over in the last run (replaced each run). */
	attachmentIssues: AttachmentIssue[];
	/** The one-time "now also sends images and files" notice was shown. */
	attachmentsNoticeShown: boolean;
	/** The last answer the server gave about attachments: its limits when it takes them,
	 * `null` when it said it does not (or never answered). A transient probe failure
	 * keeps this, so a supported vault never flips to legacy for one run. */
	attachmentServer: { maxBytes: number; maxRefsPerNote?: number } | null;
	/** Consecutive runs the server answered busy (429/503) to blob uploads. */
	attachmentBusyRuns: number;
}

/**
 * Forget everything this vault believes it has already staged.
 *
 * ⛔⛔ MUST be called whenever a connect code is redeemed. Disconnecting on the
 * server purges BOTH `j2_obsidian_staging` and `j2_obsidian_manifest` for the
 * user, so a reconnected vault faces an EMPTY staging area. If the plugin keeps
 * its old per-file state it concludes nothing changed, pushes nothing, and yet
 * still manifests every path — and the server refuses that manifest outright
 * ("manifest lists N path(s) never pushed to staging for this vault"), because
 * naming an unstaged path is exactly how a padded manifest could otherwise mass
 * -tag a member's notes as deleted.
 *
 * The member-visible symptom is a vault that silently stops syncing after a
 * disconnect/reconnect and never recovers, because no file's hash changes.
 * Found by the real-vault gate on 2026-09-04, not by any unit test.
 *
 * `vaultId` is deliberately preserved — a reconnect must reuse it so the
 * server rotates the existing device row rather than orphaning it.
 */
export function clearStagedState(data: PluginData): PluginData {
	return { ...data, files: {}, lastSyncAt: null, lastSyncError: null };
}

export const DEFAULT_SERVER_URL = 'https://uctintelligence.com';

export function defaultPluginData(vaultId: string): PluginData {
	return {
		serverUrl: DEFAULT_SERVER_URL,
		vaultId,
		deviceToken: null,
		connectedLabel: null,
		connectedAt: null,
		lastSyncAt: null,
		lastSyncError: null,
		files: {},
		syncAttachments: true,
		attachmentHashes: {},
		attachmentIssues: [],
		attachmentsNoticeShown: false,
		attachmentServer: null,
		attachmentBusyRuns: 0,
	};
}
