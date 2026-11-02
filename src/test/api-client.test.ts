/**
 * Exercises the REAL `ObsidianHttpTransport` — the only file that actually
 * imports Obsidian's `requestUrl` — with `requestUrl` itself stubbed. This
 * is the piece sync-manager.test.ts's `FakeTransport` deliberately does not
 * cover: is the outgoing request shaped correctly (URL, method, headers,
 * JSON body), and is a non-2xx response translated into the right
 * `Outcome` (especially the 401 -> authExpired mapping the whole reconnect
 * story depends on)?
 *
 * The real `obsidian` npm package ships no runtime JS at all (types only),
 * so it cannot be resolved even under `vi.mock` — `vitest.config.ts`
 * aliases the `obsidian` specifier to `src/test/obsidian-stub.ts` for tests,
 * which is what `requestUrl` below actually resolves to.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { requestUrl as requestUrlMock } from 'obsidian';
import { ObsidianHttpTransport, PLUGIN_VERSION, joinUrl } from '../api-client';
import manifest from '../../manifest.json';

describe('joinUrl', () => {
	it('joins a base with no trailing slash and a leading-slash path', () => {
		expect(joinUrl('https://uctintelligence.com', '/api/x')).toBe('https://uctintelligence.com/api/x');
	});

	it('strips a trailing slash on the base before joining', () => {
		expect(joinUrl('https://uctintelligence.com/', '/api/x')).toBe('https://uctintelligence.com/api/x');
	});
});

describe('ObsidianHttpTransport', () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
	});

	it('redeem() posts to the redeem path with the code/vaultId/label body', async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: '',
			json: { deviceId: 'd1', token: 'd1:secret', vaultId: 'v1', source: { id: 's1', provider: 'obsidian', remoteId: 'v1' } },
		});
		const transport = new ObsidianHttpTransport();
		const result = await transport.redeem({
			serverUrl: 'https://uctintelligence.com',
			code: 'CODE123',
			vaultId: 'v1',
			label: 'My Vault',
		});

		expect(result).toEqual({ ok: true, deviceId: 'd1', token: 'd1:secret', vaultId: 'v1' });
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		const call = requestUrlMock.mock.calls[0][0];
		expect(call.url).toBe('https://uctintelligence.com/api/j2/notes/connectors/obsidian/redeem');
		expect(call.method).toBe('POST');
		expect(JSON.parse(call.body)).toEqual({ code: 'CODE123', vaultId: 'v1', label: 'My Vault' });
	});

	it('ingest() sends a Bearer header and the pinned "notes" field', async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: '',
			json: { written: 1, skipped: 0, manifestReplaced: false, tooLarge: [] },
		});
		const transport = new ObsidianHttpTransport();
		const outcome = await transport.ingest({
			serverUrl: 'https://uctintelligence.com',
			token: 'd1:secret',
			notes: [{ vault_path: 'a.md', content_hash: 'h1', body_md: '# A', updated_at: '2026-09-02T00:00:00Z' }],
			final: false,
		});

		expect(outcome).toEqual({ ok: true, response: { written: 1, skipped: 0, manifestReplaced: false, tooLarge: [] } });
		const call = requestUrlMock.mock.calls[0][0];
		expect(call.url).toBe('https://uctintelligence.com/api/j2/notes/connectors/obsidian/ingest');
		expect(call.headers.Authorization).toBe('Bearer d1:secret');
		const body = JSON.parse(call.body);
		expect(body.consent).toBe(true);
		expect(body.notes).toHaveLength(1);
		expect(body.manifest).toBeUndefined();
	});

	it('omits the manifest field entirely when not provided, never sends manifest: []', async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: '',
			json: { written: 0, skipped: 0, manifestReplaced: false, tooLarge: [] },
		});
		const transport = new ObsidianHttpTransport();
		await transport.ingest({ serverUrl: 'https://x.test', token: 't', notes: [] });
		const body = JSON.parse(requestUrlMock.mock.calls[0][0].body);
		expect('manifest' in body).toBe(false);
	});

	it('maps a 401 to authExpired: true with the server-provided detail message', async () => {
		requestUrlMock.mockResolvedValue({
			status: 401,
			text: JSON.stringify({ detail: 'Not authenticated' }),
			json: undefined,
		});
		const transport = new ObsidianHttpTransport();
		const outcome = await transport.ingest({ serverUrl: 'https://x.test', token: 'dead', notes: [] });
		expect(outcome).toEqual({ ok: false, status: 401, message: 'Not authenticated', authExpired: true });
	});

	it('maps a non-401 error status to authExpired: false', async () => {
		requestUrlMock.mockResolvedValue({
			status: 403,
			text: JSON.stringify({ detail: 'Upgrade required' }),
			json: undefined,
		});
		const transport = new ObsidianHttpTransport();
		const outcome = await transport.ingest({ serverUrl: 'https://x.test', token: 't', notes: [] });
		expect(outcome).toEqual({ ok: false, status: 403, message: 'Upgrade required', authExpired: false });
	});

	it('falls back to a generic message when the error body is not the expected JSON shape', async () => {
		requestUrlMock.mockResolvedValue({ status: 502, text: '<html>Bad Gateway</html>', json: undefined });
		const transport = new ObsidianHttpTransport();
		const outcome = await transport.ingest({ serverUrl: 'https://x.test', token: 't', notes: [] });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.message).toBe('Request failed (HTTP 502).');
			expect(outcome.authExpired).toBe(false);
		}
	});
});

// ── Plan C Task 9: attachment check/upload and the plugin version header ──
// Contract: api/routers/note_sync.py on feat/connector-fidelity-c-server
// (`obsidian_attachments_check`, `obsidian_attachments_put`, PLUGIN_VERSION_HEADER).

const SHA = 'a'.repeat(64);
const SERVER = 'https://uctintelligence.com';
const ATT = `${SERVER}/api/j2/notes/connectors/obsidian/attachments`;

function respond(status: number, body: unknown) {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return {
		status,
		text,
		// Obsidian's real `json` getter throws on a non-JSON body (an SPA page)
		get json() { return JSON.parse(text); },
	};
}

const upload = (over: Partial<Parameters<ObsidianHttpTransport['uploadAttachment']>[0]> = {}) =>
	new ObsidianHttpTransport().uploadAttachment({
		serverUrl: SERVER, token: 'd1:secret', sha256: SHA, name: 'my chart #1 (v2).png',
		mime: 'image/png', data: new Uint8Array([1, 2, 3]).buffer, ...over,
	});
const check = (sha256: string[] = [SHA]) =>
	new ObsidianHttpTransport().checkAttachments({ serverUrl: SERVER, token: 'd1:secret', sha256 });

describe('ObsidianHttpTransport attachments', () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
	});

	it('sends the plugin version header on redeem, ingest, check and upload', async () => {
		expect(PLUGIN_VERSION).toBe(manifest.version);
		const t = new ObsidianHttpTransport();
		requestUrlMock.mockResolvedValueOnce(respond(200, { deviceId: 'd', token: 't', vaultId: 'v' }));
		await t.redeem({ serverUrl: SERVER, code: 'C', vaultId: 'v', label: null });
		requestUrlMock.mockResolvedValueOnce(respond(200, { written: 0, skipped: 0, manifestReplaced: false, tooLarge: [] }));
		await t.ingest({ serverUrl: SERVER, token: 't', notes: [] });
		requestUrlMock.mockResolvedValueOnce(respond(200, { protocol: 1, missing: [], maxBytes: 1, remainingBytes: 1 }));
		await check();
		requestUrlMock.mockResolvedValueOnce(respond(200, { stored: true }));
		await upload();
		expect(requestUrlMock).toHaveBeenCalledTimes(4);
		for (const [req] of requestUrlMock.mock.calls) {
			expect(req.headers['X-UCT-Plugin-Version']).toBe(PLUGIN_VERSION);
		}
	});

	it('check: 404 and 405 and a protocol-less 200 mean unsupported', async () => {
		for (const res of [
			respond(404, { detail: 'Not Found' }),
			respond(405, { detail: 'Method Not Allowed' }),
			respond(200, '<!doctype html><html>SPA</html>'),
			respond(200, { missing: [] }),
			respond(200, { protocol: '1', missing: [], maxBytes: 1, remainingBytes: 1 }),
			respond(200, { protocol: 2, missing: [], maxBytes: 1, remainingBytes: 1 }),
		]) {
			requestUrlMock.mockResolvedValueOnce(res);
			expect(await check()).toEqual({ ok: true, supported: false });
		}
	});

	it('check: 200 returns missing and limits', async () => {
		requestUrlMock.mockResolvedValueOnce(
			respond(200, { protocol: 1, missing: [SHA], maxBytes: 26214400, remainingBytes: 1000 }),
		);
		expect(await check([SHA, 'b'.repeat(64)])).toEqual({
			ok: true, supported: true, missing: [SHA], maxBytes: 26214400, remainingBytes: 1000,
		});
		const [req] = requestUrlMock.mock.calls[0];
		expect(req.url).toBe(`${ATT}/check`);
		expect(req.method).toBe('POST');
		expect(req.contentType).toBe('application/json');
		expect(req.headers.Authorization).toBe('Bearer d1:secret');
		expect(JSON.parse(req.body)).toEqual({ sha256: [SHA, 'b'.repeat(64)] });
		expect(req.throw).toBe(false);
	});

	it('check: an empty list still asks (that is how the protocol and limits are learned)', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(200, { protocol: 1, missing: [], maxBytes: 5, remainingBytes: 4 }));
		expect(await check([])).toEqual({ ok: true, supported: true, missing: [], maxBytes: 5, remainingBytes: 4 });
		expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toEqual({ sha256: [] });
	});

	it('check: never sends more than the server cap of 5000 hashes in one request', async () => {
		const many = Array.from({ length: 5001 }, (_, i) => i.toString(16).padStart(64, '0'));
		requestUrlMock
			.mockResolvedValueOnce(respond(200, { protocol: 1, missing: [many[0]], maxBytes: 9, remainingBytes: 8 }))
			.mockResolvedValueOnce(respond(200, { protocol: 1, missing: [many[5000]], maxBytes: 9, remainingBytes: 7 }));
		expect(await check(many)).toEqual({
			ok: true, supported: true, missing: [many[0], many[5000]], maxBytes: 9, remainingBytes: 7,
		});
		expect(requestUrlMock.mock.calls.map(([r]) => JSON.parse(r.body).sha256.length)).toEqual([5000, 1]);
	});

	it('check: other errors are outcomes with the server detail', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(503, { detail: 'Obsidian is not configured on this server.' }));
		expect(await check()).toEqual({
			ok: false, status: 503, message: 'Obsidian is not configured on this server.', authExpired: false,
		});
	});

	it('upload: PUT with raw ArrayBuffer body, declared mime and encoded name', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(200, { stored: true }));
		const data = new Uint8Array([9, 8, 7]).buffer;
		expect(await upload({ data })).toEqual({ ok: true, stored: true });
		const [req] = requestUrlMock.mock.calls[0];
		expect(req.url).toBe(`${ATT}/${SHA}`);
		expect(req.method).toBe('PUT');
		expect(req.body).toBe(data);
		expect(req.contentType).toBe('image/png');
		expect(req.throw).toBe(false);
		expect(req.headers.Authorization).toBe('Bearer d1:secret');
		expect(req.headers['X-UCT-Attachment-Name']).toBe(encodeURIComponent('my chart #1 (v2).png'));

		requestUrlMock.mockResolvedValueOnce(respond(200, { stored: false }));
		expect(await upload()).toEqual({ ok: true, stored: false });
	});

	it('upload: the name header carries the base name only (the server refuses a path)', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(200, { stored: true }));
		await upload({ name: 'attachments/sub/x y.png' });
		expect(requestUrlMock.mock.calls[0][0].headers['X-UCT-Attachment-Name']).toBe('x%20y.png');
	});

	it('upload: 413 storage message sets storageFull, 413 size does not', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(413, {
			detail: 'Your UCT storage for imported files is full. Free up space in the Notebook, then sync again.',
		}));
		expect(await upload()).toMatchObject({ ok: false, status: 413, storageFull: true, retryLater: false });
		requestUrlMock.mockResolvedValueOnce(respond(413, { detail: 'attachment is too large (limit 25 MB)' }));
		expect(await upload()).toMatchObject({ ok: false, status: 413, storageFull: false, retryLater: false });
	});

	it('upload: a 429 (uploads in flight at the cap) and a 503 are retry-later, never a failure', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(429, { detail: 'Too many uploads at once. Try again in a moment.' }));
		expect(await upload()).toEqual({
			ok: false, status: 429, message: 'Too many uploads at once. Try again in a moment.',
			authExpired: false, storageFull: false, retryLater: true,
		});
		requestUrlMock.mockResolvedValueOnce(respond(503, { detail: 'storage is temporarily full; try again later' }));
		expect(await upload()).toMatchObject({ ok: false, status: 503, storageFull: false, retryLater: true });
		// a hash mismatch is a real failure
		requestUrlMock.mockResolvedValueOnce(respond(400, { detail: 'content does not match its sha256' }));
		expect(await upload()).toMatchObject({ ok: false, status: 400, retryLater: false, storageFull: false });
	});

	it('upload: a 2xx without a {stored} body is not a success', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(200, '<html>proxy</html>'));
		expect(await upload()).toMatchObject({ ok: false, status: 200, retryLater: false });
	});

	it('401 sets authExpired on both', async () => {
		requestUrlMock.mockResolvedValueOnce(respond(401, { detail: 'Not authenticated' }));
		expect(await check()).toEqual({ ok: false, status: 401, message: 'Not authenticated', authExpired: true });
		requestUrlMock.mockResolvedValueOnce(respond(401, { detail: 'Not authenticated' }));
		expect(await upload()).toMatchObject({ ok: false, status: 401, authExpired: true, storageFull: false, retryLater: false });
	});

	it('upload: every name the server would refuse is shaped to pass its _attachment_name rule (M1)', async () => {
		// A JS port of note_sync.py::_attachment_name's refusal, applied to the decoded header.
		const serverRefuses = (decoded: string) =>
			Array.from(decoded).length > 255 || decoded.includes('/') || decoded.includes('\\')
			|| Array.from(decoded).some((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f)
			|| decoded === '.' || decoded === '..';
		const longStem = 'x'.repeat(300);
		const cases: [string, string | undefined][] = [
			['a\\b.png', 'a_b.png'],
			['tab\there.png', 'tab_here.png'],
			['line\nbreak.png', 'line_break.png'],
			['del\u007f.png', 'del_.png'],
			['bad\ud800half.png', 'bad�half.png'],
			[`${longStem}.png`, `${'x'.repeat(251)}.png`],
			[`${'😀'.repeat(300)}.png`, `${'😀'.repeat(251)}.png`],
			['dir/..', undefined],
			['.', undefined],
			['folder/', undefined],
		];
		for (const [name, want] of cases) {
			requestUrlMock.mockReset();
			requestUrlMock.mockResolvedValueOnce(respond(200, { stored: true }));
			expect(await upload({ name })).toEqual({ ok: true, stored: true });
			const header = requestUrlMock.mock.calls[0][0].headers['X-UCT-Attachment-Name'] as string | undefined;
			if (want === undefined) {
				expect(header).toBeUndefined();
				continue;
			}
			const decoded = decodeURIComponent(header!);
			expect(decoded).toBe(want);
			expect(serverRefuses(decoded)).toBe(false);
		}
	});

	it('upload: a PUT 404 or 405 (attachments switched off mid-run) is retry-later (M2)', async () => {
		for (const status of [404, 405]) {
			requestUrlMock.mockResolvedValueOnce(respond(status, { detail: 'Not Found' }));
			expect(await upload()).toMatchObject({ ok: false, status, retryLater: true, storageFull: false, authExpired: false });
		}
	});

	it('upload: a sha that is not 64 lowercase hex is a failure without a request', async () => {
		for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), '../x', '']) {
			expect(await upload({ sha256 })).toMatchObject({ ok: false, status: 0, retryLater: false, storageFull: false });
		}
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it('redeem and ingest never throw: a network error or a non-JSON 2xx is a failure outcome', async () => {
		const t = new ObsidianHttpTransport();
		requestUrlMock.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
		expect(await t.redeem({ serverUrl: SERVER, code: 'C', vaultId: 'v', label: null }))
			.toEqual({ ok: false, status: 0, message: 'net::ERR_NAME_NOT_RESOLVED' });
		requestUrlMock.mockResolvedValueOnce(respond(200, '<html>SPA</html>'));
		expect(await t.redeem({ serverUrl: SERVER, code: 'C', vaultId: 'v', label: null }))
			.toMatchObject({ ok: false, status: 200 });
		requestUrlMock.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'));
		expect(await t.ingest({ serverUrl: SERVER, token: 't', notes: [] }))
			.toEqual({ ok: false, status: 0, message: 'net::ERR_CONNECTION_RESET', authExpired: false });
		requestUrlMock.mockResolvedValueOnce(respond(200, '<html>SPA</html>'));
		expect(await t.ingest({ serverUrl: SERVER, token: 't', notes: [] }))
			.toMatchObject({ ok: false, status: 200, authExpired: false });
		requestUrlMock.mockResolvedValueOnce(respond(200, { unexpected: true }));
		expect(await t.ingest({ serverUrl: SERVER, token: 't', notes: [] }))
			.toMatchObject({ ok: false, status: 200, authExpired: false });
	});

	it('a thrown network error is an outcome, never an exception', async () => {
		requestUrlMock.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));
		expect(await check()).toEqual({
			ok: false, status: 0, message: 'net::ERR_CONNECTION_REFUSED', authExpired: false,
		});
		requestUrlMock.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'));
		expect(await upload()).toEqual({
			ok: false, status: 0, message: 'net::ERR_CONNECTION_RESET', authExpired: false, storageFull: false, retryLater: false,
		});
	});
});
