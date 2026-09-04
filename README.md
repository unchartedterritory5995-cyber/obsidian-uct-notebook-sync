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
    large once converted (see "Too-large notes" below) — never a silent
    failure.
- Adds a **command** ("Sync vault to UCT Notebook") and a **ribbon icon**
  for manual sync — there is no background/scheduled sync in this first
  release (see "Deliberately out of scope").
- On sync: enumerates every markdown file in the vault, hashes its content,
  pushes only the files that changed since the last sync (in batches), then
  sends the vault's complete current file list as a `final` manifest so the
  server can detect deletions.

## What it does NOT do (by design)

- **No attachment/image upload.** Only markdown text is sent. An
  `![[embedded image]]` or a link to a local file stays as a broken
  reference in the synced copy — the server-side provider
  (`providers/obsidian.py::fetch_media`) refuses local vault attachments
  outright. A note that already links to a public `https://` image is the
  one case that resolves.
- **Nothing is ever written back into the vault.** This is a one-way push.
- **No background/interval sync in v1.** Sync only runs when the member
  clicks "Sync now", runs the command, or clicks the ribbon icon. Adding a
  periodic timer is a natural v2, deliberately left out to keep this first
  release small enough to review honestly.
- **Desktop only** (`isDesktopOnly: true` in `manifest.json`). The plugin
  uses Node's `crypto` module directly for hashing and vault-id generation,
  which Obsidian's mobile (Capacitor) runtime does not provide to plugins.
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
  hashing.ts         sha256Hex() — content hashing.
  batching.ts         Splits changed notes into batches under the server's
                      note-count and byte-size ceilings.
  sync-plan.ts         Pure decision logic: what to push, what to manifest,
                      too-large tracking, delete detection. No obsidian import.
  api-client.ts        Transport interface + ObsidianHttpTransport (the one
                      file that imports obsidian's requestUrl).
  sync-manager.ts       Orchestrates scan -> plan -> batch -> push -> manifest
                      -> persist. Depends only on the Transport/VaultSource
                      interfaces — no obsidian import.
  vault-source.ts        ObsidianVaultSource — thin adapter over app.vault.
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
```

`sync-plan.ts`, `batching.ts`, `hashing.ts`, and `sync-manager.ts`
deliberately have **zero** dependency on the `obsidian` module — every
decision the plugin makes is unit-testable in plain Node, with no live
vault and no live server. Only `api-client.ts`, `vault-source.ts`,
`settings.ts`, and `main.ts` touch the real Obsidian API.

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

Matches the disclosure shown in the dashboard's own "Connect Obsidian"
modal before a connect code can be minted: once connected, this plugin sends the **markdown text** of vault notes
(file path, content, and last-modified time) to the configured server. It
does **not** upload attachments or images stored in the vault, and nothing
is ever written back into the vault. Consent is captured on the dashboard
side, before a connect code can even be minted — this plugin has no
separate consent surface of its own because a device token cannot exist
without that consent having already been given.
