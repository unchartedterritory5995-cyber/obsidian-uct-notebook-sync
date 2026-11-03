# UCT Notebook Sync (Obsidian plugin)

One-way sync of an Obsidian vault's markdown notes into your **UCT
Intelligence Notebook** (Journal 2.0). The plugin only ever *pushes* — it
never writes anything back into your vault.

## Requirements

- **Obsidian 1.5.0 or newer, desktop only.** The plugin hashes file contents
  with Node's `crypto`, which Obsidian's mobile runtime does not expose to
  plugins (`isDesktopOnly: true`).
- **A UCT Intelligence account with an active subscription.** This plugin is
  a client for [uctintelligence.com](https://uctintelligence.com) — it syncs
  into that product's Notebook and does nothing on its own. The Notebook and
  its connectors are a paid feature; without an account there is nothing for
  the plugin to connect to.

## Setup

1. Install and enable the plugin.
2. In UCT Intelligence, open **Settings → Connections → Obsidian** and click
   **Connect**. Accept the consent notice; the dashboard shows a short-lived
   **connect code**.
3. In Obsidian, open **Settings → UCT Notebook Sync**, paste the connect code,
   and click **Connect**. The plugin exchanges it for a long-lived device
   token stored in this vault only.
4. Click **Sync now** (or run the *Sync vault to UCT Notebook* command, or
   click the ribbon icon).

Disconnecting from the dashboard revokes the device token immediately; the
plugin's next sync will report that it is no longer connected, and you can
reconnect with a fresh code at any time.

## What the plugin does

- Adds a **Settings tab** ("UCT Notebook Sync") with:
  - A **Server URL** field (defaults to `https://uctintelligence.com`).
  - A **connect code** field — paste the code the dashboard's "Connect
    Obsidian" modal generates, and the plugin exchanges it for a
    long-lived device token (`POST /obsidian/redeem`).
  - A **Sync now** button, connection status, last-sync timestamp, and the
    last sync error (if any).
  - A visible list of **notes that could not sync** because they're too
    large to send or to store once converted (see "Too-large notes" below) —
    never a silent failure.
  - A **Sync images and files** toggle (on by default) and a list of the
    **images and files that could not sync**, each with its reason.
- Adds a **command** ("Sync vault to UCT Notebook") and a **ribbon icon**
  for manual sync — there is no background/scheduled sync in this first
  release (see "Deliberately out of scope").
- On sync: enumerates every markdown file in the vault, hashes its content,
  pushes only the files that changed since the last sync (in batches), then
  sends the vault's complete current file list as a `final` manifest so the
  server can detect deletions.
- **Images and files (0.2.0).** Before pushing notes, the plugin asks
  Obsidian's own link index which images and files each note embeds or links
  to, resolved exactly as Obsidian resolves them. It uploads each such file
  the server does not already hold, **once** (files are identified by their
  SHA-256, so the same file used by many notes, or renamed, is never sent
  twice), and pushes each note with the list of files it uses. Only files a
  note actually references are ever read or sent; a file that resolves
  outside the vault index (for example inside `.obsidian/`) never resolves at
  all. Per-file and per-member limits come from the server (25 MB per file
  today). A run uploads for about a minute (or 100 MB) and then pushes the
  note text; remaining files follow on later syncs, and the Notebook shows
  them as "retrying" until they arrive. A file that cannot come over (too
  large, missing from the vault, storage full) is shown as a notice in the
  note and listed in Settings. An older UCT server without this feature is
  detected automatically, and the plugin then behaves exactly as 0.1.x did.

## What it does NOT do (by design)

- **No file a note does not reference is ever read or sent**, and nothing
  outside Obsidian's vault index (such as `.obsidian/`, where this plugin's
  own token lives) can be. With **Sync images and files** turned off, no
  file contents are sent at all (see "Privacy" for what is still sent).
- **Nothing is ever written back into the vault.** This is a one-way push.
- **No background/interval sync in v1.** Sync only runs when the member
  clicks "Sync now", runs the command, or clicks the ribbon icon. Adding a
  periodic timer is a natural v2, deliberately left out to keep this first
  release small enough to review honestly.
- **Desktop only** (`isDesktopOnly: true` in `manifest.json`). The plugin
  hashes notes and files synchronously with Node's `crypto` module, which
  Obsidian's mobile (Capacitor) runtime does not provide to plugins.
- **No infinite retry of a too-large note.** See below.
- **A rename is not tracked as a rename.** Every note's server-side identity
  is derived from its `vault_path` (there is no stable per-note id this
  plugin can read from the vault and forward). Renaming or moving a file
  therefore looks, to the server, exactly like the old path disappearing
  (garbage-collected out of `data.files` here, then delete-detected
  server-side after a couple of missed passes) and a genuinely new path
  appearing (pushed as a brand-new note). Content is never lost — the old
  server-side copy survives until delete-detection catches up, and the new
  path syncs immediately — but a member who has already started editing that
  note inside the Notebook should expect the rename to surface as two
  notes for a short window, not an in-place rename. Fixing this needs a
  stable note id on the wire, which is a two-repo (plugin + server) change
  and out of scope for this release.
- **No retry/backoff on a transient failure.** A network blip or a 5xx mid-run
  fails the whole sync (see `sync-manager.ts`'s auth-failure section for the
  one exception — a 401 clears the token deliberately, rather than retrying
  a dead credential). Nothing is lost: notes already durably staged by an
  earlier batch in the same run are simply re-pushed next time (the server
  no-ops an unchanged `content_hash`), and no manifest is ever sent for a
  run that didn't finish pushing every batch — so a mid-run failure can
  never mark a real note deleted. Recovery today is a member clicking "Sync
  now" again. An automatic retry (with backoff) is the natural v1.1 on top
  of this, deliberately deferred for the same reason as background sync:
  keeping this first release small enough to review honestly.

## Too-large notes — the one failure mode that must never be silent

The server has a hard ceiling on how large a note's *converted* body may be
(`obsidian_staging.MAX_BODY_MD_LEN`, currently derived as roughly 212,765
characters of markdown — measured markdown→TipTap blowup is 3.4–4.7×, up to
~9× for a many-short-headings shape). A note over that ceiling **will never
store**, no matter how many times it's re-pushed.

This plugin therefore:

1. Tracks, per vault path, whether the server's most recent verdict for that
   file's exact content was `tooLarge`.
2. **Never re-pushes an unchanged too-large file on a later sync** — that
   would just fail identically forever and waste the member's bandwidth.
3. **Retries automatically the moment the file's content changes** (the
   member shortened it, split it, etc.) — exactly once, based on the new
   content.
4. **Surfaces every currently-too-large file by name** in the Settings tab,
   with a manual "Retry all now" override, so the member always knows which
   notes aren't syncing and why — never a silent gap between "13 notes in
   Obsidian" and "12 notes in the Notebook."
5. **Never names a too-large path in a `final` manifest** — the server's
   own manifest-integrity check (`obsidian_staging.py`'s I3 finding) treats
   a manifest entry as a claim "this vault has staged body content for this
   path," which is false for a note that was always rejected as too large.

See `src/sync-plan.ts`'s module docstring for the full reasoning and
`src/test/sync-plan.test.ts` / `src/test/sync-manager.test.ts` for the
tests that pin this behavior.

## Architecture

```
src/
  types.ts          Wire shapes + persisted-settings shape. No obsidian import.
  hashing.ts         sha256Hex() / sha256HexBytes() — note and file hashing.
  batching.ts         Splits changed notes into batches under the server's
                      note-count and byte-size ceilings; the 2 MB request check.
  sync-plan.ts         Pure decision logic: what to push, what to manifest,
                      too-large tracking, delete detection. No obsidian import.
  server-url.ts        Server URL validation and normalization.
  api-client.ts        Transport interface + ObsidianHttpTransport (the one
                      file that makes network requests, via requestUrl):
                      redeem, ingest, attachment check and upload.
  attachment-refs.ts   Which of a note's links are attachments (classifyRef),
                      MIME types, and the attachment-aware content hash.
  attachment-sync.ts   Phase 0 of a sync: build each note's refs, check which
                      files the server lacks, upload them within the budget.
  sync-manager.ts       Orchestrates attachments -> scan -> plan -> batch ->
                      push -> manifest -> persist, over the Transport and
                      VaultSource interfaces.
  vault-source.ts        ObsidianVaultSource — thin adapter over app.vault and
                      app.metadataCache (Obsidian's own link resolver).
  settings.ts          The settings tab UI.
  main.ts             Plugin entry point; wires everything above together.
styles.css            The one class settings.ts needs (a themed error color)
                      — per Obsidian's guidelines, a CSS class instead of an
                      inline style. Everything else uses Obsidian's own
                      built-in Setting/`setting-item-description` styling.
test/
  hashing.test.ts, batching.test.ts, sync-plan.test.ts   Pure-function unit tests.
  sync-manager.test.ts    Stubbed-transport, stubbed-vault integration tests
                        covering batching, the two-phase push, tooLarge
                        exclusion/retry, delete detection, and 401 handling.
  api-client.test.ts     Exercises the real HTTP-shaping logic against a
                        stubbed requestUrl (obsidian-stub.ts).
  attachment-refs.test.ts, attachment-sync.test.ts, vault-source.test.ts
                        Attachment classification, phase 0 against a fake
                        vault and a fake server, and the Obsidian adapter.
  fixtures/server-parity/ Copies of the server's parity fixtures: the refs this
                        plugin builds must equal the refs the server expects.
```

`sync-plan.ts`, `batching.ts` and `hashing.ts` have **zero** dependency on
the `obsidian` module. `sync-manager.ts` and `attachment-sync.ts` depend only
on the Transport/VaultSource interfaces, plus `parseLinktext` through
`attachment-refs.ts`; the tests alias `obsidian` to `src/test/obsidian-stub.ts`,
so every decision the plugin makes is unit-testable in plain Node, with no
live vault and no live server.

## The wire contract (server side — read before changing anything here)

This plugin is one half of a contract whose other half lives in the
closed-source UCT Intelligence server. The server-side names below are
recorded so a future change on either side is made deliberately aware of the
other:

- `api/routers/note_sync.py` — `POST /obsidian/redeem`,
  `POST /obsidian/ingest`, `ObsidianRedeemBody`, `ObsidianIngestBody`.
  `OBSIDIAN_INGEST_NOTES_FIELD` ("notes") is **pinned** — do not rename the
  top-level notes-array key.
- `api/services/journal_two/note_connectors/obsidian_staging.py` —
  `ingest_batch`'s caps, the too-large isolation logic, and the manifest
  integrity check (a `final` manifest may only name paths already staged
  for this vault — either in the same call or an earlier one).
- `api/services/journal_two/note_connectors/obsidian_link.py` — connect-code
  mint/redeem and device-token semantics (reconnecting the same
  `vaultId` **rotates** the device token rather than refusing).
- `api/routers/note_sync.py` (0.2.0) — `POST /obsidian/attachments/check`
  (`protocol`, `missing`, `maxBytes`, `remainingBytes`, `maxRefsPerNote`),
  `PUT /obsidian/attachments/{sha256}`, the per-note `attachments` list on
  ingest (`ObsidianAttachmentRef`), and the `X-UCT-Plugin-Version` header.
  `providers/obsidian.py` turns each ref's `original` into the image, file chip
  or notice. A 404/405 on the check route means "no attachment support".

If the server-side contract changes, this plugin needs a matching update —
there is no shared type-checking across the two repositories, so changes on
either side must be made deliberately aware of the other.

## Development

```bash
npm install
npm run dev      # esbuild watch mode -> main.js
npm run build    # tsc typecheck + production esbuild bundle
npm test         # vitest — all unit/integration tests, no live server
```

To try the plugin in a real vault during development, symlink (or copy)
this repository into `<vault>/.obsidian/plugins/uct-notebook-sync/` after
running `npm run build`, then enable it in Obsidian's Community Plugins
settings (with Restricted Mode turned off for that vault).

## Privacy / consent

Once connected, this plugin sends to the configured server, and only to the
server the device token was issued by:

- the **markdown text** of vault notes (file path, content, and last-modified
  time);
- **the images and files your notes reference** (0.2.0): their contents,
  uploaded once each, plus for each note the list of files it uses (the link
  text as written, the file's vault path, size and SHA-256). Files no note
  references are never read or sent. A referenced file that is not in the
  vault is reported by the name as written;
- with **Sync images and files turned off**, no file contents are sent, but
  each note's list still names the files it references (link text, vault
  path and size, no contents), so the Notebook can show where they were;
- on every request, an `X-UCT-Plugin-Version` header with this plugin's
  version.

Nothing is ever written back into the vault. The device token is stored in
this vault's plugin data (`.obsidian/plugins/uct-notebook-sync/data.json`);
if you sync your vault folder with another tool, that file travels with it.

Consent is captured on the dashboard side, before a connect code can even be
minted. Members who connected under 0.1.x (note text only) see a one-time
notice on the first sync that would send files, and that sync sends nothing
about files at all (no file contents, no file lists: only note text, as
0.1.x did). File lists and uploads start on the next sync, unless file sync
has been turned off in Settings by then.
