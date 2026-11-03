import { describe, expect, it } from 'vitest';
import { issueText, shortenForDisplay, visibleIssues } from '../settings';
import type { AttachmentIssue } from '../types';

describe('visibleIssues (final review M6)', () => {
	const many = (n: number): AttachmentIssue[] =>
		Array.from({ length: n }, (_, i) => ({ path: `f${i}.png`, reason: 'missing', size: 0 }));

	it('shows at most 200 and counts the rest', () => {
		const { shown, more } = visibleIssues(many(5000));
		expect(shown).toHaveLength(200);
		expect(shown[0]!.path).toBe('f0.png');
		expect(more).toBe(4800);
	});

	it('shows a short list whole', () => {
		expect(visibleIssues(many(3))).toEqual({ shown: many(3), more: 0 });
		expect(visibleIssues(many(200)).more).toBe(0);
	});
});

describe('issueText (final review I3, M2)', () => {
	it('builds limit texts from the server answer, never a hard-coded number', () => {
		expect(issueText({ path: 'a.md', reason: 'too-many-files', size: 0, limit: 1200 }))
			.toBe('more than 1200 images and files in one note; the rest were not sent');
		expect(issueText({ path: 'x.png', reason: 'too-large', size: 99, limit: 10 * 1024 * 1024 }))
			.toBe('larger than 10 MB');
		expect(issueText({ path: 'x.png', reason: 'too-large', size: 99, limit: 1_572_864 }))
			.toBe('larger than 1.5 MB');
		// without a limit, nothing invented
		expect(issueText({ path: 'a.md', reason: 'too-many-files', size: 0 }))
			.toBe('too many images and files in one note; the rest were not sent');
		expect(issueText({ path: 'x.png', reason: 'too-large', size: 99 })).toBe('larger than UCT accepts');
		// a server sentence wins
		expect(issueText({ path: 'x', reason: 'upload-failed', size: 0, message: 'Upgrade required' })).toBe('Upgrade required');
	});
});

describe('shortenForDisplay', () => {
	it('leaves a path of up to 120 characters as it is', () => {
		const p = `att/${'x'.repeat(112)}.png`; // 120
		expect(shortenForDisplay(p)).toBe(p);
		expect(shortenForDisplay('')).toBe('');
	});

	it('cuts a longer one to 120 code points with an ellipsis, keeping the file name at the end', () => {
		const p = `${'dir/'.repeat(300)}my chart.png`;
		const s = shortenForDisplay(p);
		expect(Array.from(s)).toHaveLength(120);
		expect(s).toContain('…');
		expect(s.endsWith('my chart.png')).toBe(true);
		expect(s.startsWith('dir/dir/')).toBe(true);
	});

	it('counts code points, never splitting a surrogate pair', () => {
		const p = '😀'.repeat(200);
		const s = shortenForDisplay(p);
		expect(Array.from(s)).toHaveLength(120);
		expect(s).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
	});
});
