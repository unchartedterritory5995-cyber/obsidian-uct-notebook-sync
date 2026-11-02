import { describe, expect, it } from 'vitest';
import { shortenForDisplay } from '../settings';

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
