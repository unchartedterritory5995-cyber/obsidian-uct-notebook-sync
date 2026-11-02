import { describe, expect, it } from 'vitest';
import { validateServerUrl } from '../server-url';

describe('validateServerUrl', () => {
	it.each([
		['https://uctintelligence.com', 'https://uctintelligence.com'],
		['  https://uctintelligence.com/  ', 'https://uctintelligence.com'],
		['uctintelligence.com', 'https://uctintelligence.com'],
		['https://uctintelligence.com/journal?j2tab=notebook', 'https://uctintelligence.com'],
		['http://localhost:8077', 'http://localhost:8077'],
		['http://127.0.0.1:8000/', 'http://127.0.0.1:8000'],
	])('accepts %s as %s', (raw, url) => expect(validateServerUrl(raw)).toEqual({ ok: true, url }));

	it.each(['', 'not a url at all', 'ftp://uctintelligence.com', 'http://uctintelligence.com',
		'https://user:pw@uctintelligence.com', 'javascript:alert(1)'])('rejects %j with guidance', (raw) => {
		const r = validateServerUrl(raw);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toMatch(/https:\/\/uctintelligence\.com/);
	});

	it.each([
		['', 'Enter your UCT address, for example https://uctintelligence.com'],
		['ftp://uctintelligence.com', "That isn't a web address. Use the address you open UCT at, for example https://uctintelligence.com"],
		['http://uctintelligence.com', 'Use https:// for this address, for example https://uctintelligence.com'],
		['https://user:pw@uctintelligence.com', 'Remove the username and password from the address, for example https://uctintelligence.com'],
	])('says exactly what to fix for %j', (raw, message) => {
		expect(validateServerUrl(raw)).toEqual({ ok: false, message });
	});
});
