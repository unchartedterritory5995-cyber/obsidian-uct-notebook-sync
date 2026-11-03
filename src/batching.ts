/**
 * Splits a flat list of notes to push into ordered batches bounded by both
 * count and byte size, so one `POST /obsidian/ingest` call never risks the
 * server's hard caps:
 *   - `_MAX_NOTES_PER_BATCH = 2000` (obsidian_staging.py) — an all-or-nothing
 *     rejection of the WHOLE batch if exceeded.
 *   - `_MAX_OBSIDIAN_INGEST_BYTES = 2_000_000` declared Content-Length
 *     (note_sync.py) — also enforced on the raw body stream regardless of
 *     what Content-Length claims.
 *
 * The defaults here (`DEFAULT_BATCH_OPTIONS`) sit well under BOTH server
 * ceilings on purpose: JSON-encoding overhead (per-note keys, quoting,
 * escaping newlines inside markdown) inflates a UTF-8 byte count by a
 * non-trivial margin, and this module has no visibility into the OTHER
 * fields (`consent`, `final`, per-note `vault_path`/`content_hash`/
 * `updated_at`) that also count against the server's 2MB ceiling.
 */
import type { NoteInput } from './types';

export interface BatchOptions {
	/** Never let a batch exceed this many notes. */
	maxNotes: number;
	/** Never let a batch's total `body_md` byte count exceed this. A single
	 * note whose OWN body already exceeds this becomes a singleton batch —
	 * it is not split (the schema has no way to split one note's body across
	 * two ingest calls), and is left for the SERVER to isolate via `tooLarge`
	 * if it truly cannot be stored. */
	maxBytes: number;
}

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
	maxNotes: 200,
	maxBytes: 1_500_000,
};

// A conservative fixed per-note overhead estimate (JSON punctuation + the
// other three string fields) — not exact, just enough margin that
// `maxBytes` stays a real safety margin under the server's byte ceiling
// rather than a number this module could blow past by counting only
// `body_md`.
const OVERHEAD_PER_NOTE_BYTES = 512;

/** The server's `_MAX_OBSIDIAN_INGEST_BYTES` (api/routers/note_sync.py): one ingest
 * request body over this is refused whole. */
export const MAX_INGEST_BYTES = 2_000_000;

/** The UTF-8 size of an ingest request carrying only `note`: what it costs when the
 * batcher sends it alone. */
export function singleNoteRequestBytes(note: NoteInput): number {
	return new TextEncoder().encode(JSON.stringify({ consent: true, notes: [note], final: false })).length;
}

/** JSON keys, punctuation and numbers around one note in a request, and around one ref:
 * generous over-counts, so the upper bound below stays an upper bound. */
const REQUEST_FRAME_BYTES = 200;
const REF_FRAME_BYTES = 120;
/** One UTF-16 unit is at most 6 bytes once JSON-escaped and UTF-8 encoded (`\u0000`). */
const MAX_BYTES_PER_UNIT = 6;

/**
 * Whether `note` sent alone would be over `MAX_INGEST_BYTES`, without serializing it
 * unless it has to (review N2). Every UTF-16 unit costs at least 1 and at most 6 bytes
 * on the wire, so the character count gives a sound lower and upper bound. Only a note
 * between the two (bodies from about 330 KB up to 2 MB) is serialized and measured
 * exactly, so the 2 MB guarantee never rests on an estimate.
 */
export function exceedsIngestCap(note: NoteInput): boolean {
	let units = note.vault_path.length + note.content_hash.length + note.body_md.length + note.updated_at.length;
	const refs = note.attachments ?? [];
	for (const r of refs) units += r.original.length + r.path.length + (r.sha256?.length ?? 4) + r.status.length;
	const lower = units;
	const upper = units * MAX_BYTES_PER_UNIT + REQUEST_FRAME_BYTES + refs.length * REF_FRAME_BYTES;
	if (upper <= MAX_INGEST_BYTES) return false;
	if (lower > MAX_INGEST_BYTES) return true;
	return singleNoteRequestBytes(note) > MAX_INGEST_BYTES;
}

// `TextEncoder` (a typed DOM global, already in tsconfig's `lib`) rather than
// Node's `Buffer.byteLength` — identical UTF-8 byte count, one less Node
// builtin reached through a bare specifier that types as `any` under a
// type-aware lint that resolves modules differently than this repo's tsc.
const UTF8 = new TextEncoder();

function utf8ByteLength(s: string): number {
	return UTF8.encode(s).length;
}

/** Pure, deterministic, order-preserving. Returns `[]` for an empty input. */
export function buildBatches(
	notes: NoteInput[],
	opts: BatchOptions = DEFAULT_BATCH_OPTIONS,
): NoteInput[][] {
	if (notes.length === 0) return [];

	const batches: NoteInput[][] = [];
	let current: NoteInput[] = [];
	let currentBytes = 0;

	for (const note of notes) {
		const noteBytes = utf8ByteLength(note.body_md) + OVERHEAD_PER_NOTE_BYTES
			// attachment refs ride in the same JSON body
			+ utf8ByteLength(JSON.stringify(note.attachments ?? []));
		const wouldExceedBytes = current.length > 0 && currentBytes + noteBytes > opts.maxBytes;
		const wouldExceedCount = current.length >= opts.maxNotes;
		if (wouldExceedBytes || wouldExceedCount) {
			batches.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(note);
		currentBytes += noteBytes;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}
