import { describe, expect, it, vi } from 'vitest';
import {
	buildBatches, exceedsIngestCap, MAX_INGEST_BYTES, singleNoteRequestBytes, type BatchOptions,
} from '../batching';
import type { NoteInput } from '../types';

function note(path: string, bodyLen = 10): NoteInput {
	return {
		vault_path: path,
		content_hash: 'h',
		body_md: 'x'.repeat(bodyLen),
		updated_at: '2026-09-02T00:00:00.000Z',
	};
}

describe('exceedsIngestCap (N2)', () => {
	it('decides a small note without serializing it', () => {
		const spy = vi.spyOn(JSON, 'stringify');
		expect(exceedsIngestCap(note('a.md', 1000))).toBe(false);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('stays exact near the cap, where an estimate would be wrong both ways', () => {
		// 1,000,001 quotes: about 1 MB of characters but over 2 MB once JSON-escaped
		const quotes = { ...note('q.md'), body_md: '"'.repeat(1_000_001) };
		expect(exceedsIngestCap(quotes)).toBe(true);
		expect(singleNoteRequestBytes(quotes)).toBeGreaterThan(MAX_INGEST_BYTES);
		// 1.9 MB of plain text is under
		const plain = { ...note('p.md'), body_md: 'x'.repeat(1_900_000) };
		expect(exceedsIngestCap(plain)).toBe(false);
		// a body whose length alone is over the cap is over without serializing
		const spy = vi.spyOn(JSON, 'stringify');
		expect(exceedsIngestCap({ ...note('h.md'), body_md: 'x'.repeat(2_000_001) })).toBe(true);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('counts the attachment list', () => {
		const ref = {
			original: '![[a.png]]', embed: true, path: 'att/a.png', size: 1, sha256: 'a'.repeat(64), status: 'ok' as const,
		};
		const n = { ...note('r.md'), body_md: 'x'.repeat(1_990_000), attachments: Array(200).fill(ref) };
		expect(exceedsIngestCap(n)).toBe(singleNoteRequestBytes(n) > MAX_INGEST_BYTES);
		expect(exceedsIngestCap(n)).toBe(true);
	});
});

describe('buildBatches', () => {
	it('counts attachment refs toward the batch byte budget', () => {
		const ref = {
			original: `![[${'n'.repeat(400)}.png]]`, embed: true, path: `att/${'n'.repeat(400)}.png`,
			size: 1, sha256: 'a'.repeat(64), status: 'ok' as const,
		};
		const withRefs = (p: string): NoteInput => ({ ...note(p, 10), attachments: [ref] });
		// body 10 + overhead 512 = 522 a note: two fit in 1100 bytes without refs...
		const opts: BatchOptions = { maxNotes: 1000, maxBytes: 1100 };
		expect(buildBatches([note('a.md'), note('b.md')], opts).map((b) => b.length)).toEqual([2]);
		// ...but each ref adds ~900 JSON bytes, so the same two notes split
		expect(buildBatches([withRefs('a.md'), withRefs('b.md')], opts).map((b) => b.length)).toEqual([1, 1]);
	});

	it('returns an empty array for no notes', () => {
		expect(buildBatches([])).toEqual([]);
	});

	it('puts everything in one batch when well under both limits', () => {
		const notes = [note('a.md'), note('b.md'), note('c.md')];
		const batches = buildBatches(notes);
		expect(batches).toEqual([notes]);
	});

	it('splits on the note-count ceiling', () => {
		const opts: BatchOptions = { maxNotes: 2, maxBytes: 1_000_000 };
		const notes = [note('a.md'), note('b.md'), note('c.md'), note('d.md'), note('e.md')];
		const batches = buildBatches(notes, opts);
		expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
		// Order and identity are preserved across the split.
		expect(batches.flat().map((n) => n.vault_path)).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
	});

	it('splits on the byte-size ceiling', () => {
		// Each note's body is 100 bytes; a 250-byte ceiling (before the
		// per-note overhead constant) forces a new batch well before the
		// count ceiling would ever fire.
		const opts: BatchOptions = { maxNotes: 1000, maxBytes: 250 };
		const notes = [note('a.md', 100), note('b.md', 100), note('c.md', 100)];
		const batches = buildBatches(notes, opts);
		// With a ~512-byte fixed overhead per note dominating the 250-byte
		// ceiling, every note ends up in its own batch — the point of this
		// test is that it splits at all, not the exact shape.
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toHaveLength(3);
	});

	it('gives a single oversized note its own batch instead of dropping or crashing', () => {
		const opts: BatchOptions = { maxNotes: 10, maxBytes: 1000 };
		const huge = note('huge.md', 5000);
		const notes = [note('small.md', 10), huge, note('small2.md', 10)];
		const batches = buildBatches(notes, opts);
		// The huge note must appear exactly once, alone in its own batch —
		// it is never split, never silently dropped.
		const huges = batches.filter((b) => b.some((n) => n.vault_path === 'huge.md'));
		expect(huges).toHaveLength(1);
		expect(huges[0]).toHaveLength(1);
		expect(batches.flat()).toHaveLength(3);
	});

	it('never produces an empty batch', () => {
		const opts: BatchOptions = { maxNotes: 1, maxBytes: 1_000_000 };
		const notes = [note('a.md'), note('b.md'), note('c.md')];
		const batches = buildBatches(notes, opts);
		expect(batches.every((b) => b.length > 0)).toBe(true);
		expect(batches).toHaveLength(3);
	});
});
