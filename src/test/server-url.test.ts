import { describe, expect, it } from 'vitest';
import { normalizeSavedServerUrl, validateServerUrl } from '../server-url';

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

describe('normalizeSavedServerUrl', () => {
	const run = async (serverUrl: string) => {
		const data = { serverUrl };
		const saves: string[] = [];
		const result = await normalizeSavedServerUrl(data, async () => { saves.push(data.serverUrl); });
		return { result, data, saves };
	};

	it.each([
		['uctintelligence.com', 'https://uctintelligence.com'],
		['https://uctintelligence.com/journal', 'https://uctintelligence.com'],
		['localhost:8077', 'https://localhost:8077'],
		['https://uctintelligence.com/', 'https://uctintelligence.com'],
	])('rewrites legacy %s to %s once and persists it', async (raw, url) => {
		const { result, data, saves } = await run(raw);
		expect(result).toEqual({ ok: true, url });
		expect(data.serverUrl).toBe(url);
		expect(saves).toEqual([url]);
	});

	it('does not save when the stored value is already normalized', async () => {
		const { result, saves } = await run('https://uctintelligence.com');
		expect(result.ok).toBe(true);
		expect(saves).toEqual([]);
	});

	it('does not save or change an invalid value', async () => {
		const { result, data, saves } = await run('http://uctintelligence.com');
		expect(result.ok).toBe(false);
		expect(data.serverUrl).toBe('http://uctintelligence.com');
		expect(saves).toEqual([]);
	});
});

describe('validateServerUrl extra cases', () => {
	it.each([
		['http://[::1]:8000', 'http://[::1]:8000'],
		['HTTPS://UctIntelligence.com:443/x', 'https://uctintelligence.com'],
	])('accepts %s', (raw, url) => expect(validateServerUrl(raw)).toEqual({ ok: true, url }));

	it('rejects http://localhost@evil.com (host is evil.com, with credentials)', () => {
		expect(validateServerUrl('http://localhost@evil.com').ok).toBe(false);
	});
});
