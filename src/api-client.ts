/**
 * HTTP transport to the note-sync server. Split into a plain `Transport`
 * interface (what `sync-manager.ts` depends on — trivially fakeable in
 * tests) and `ObsidianHttpTransport`, the one concrete implementation that
 * actually talks to the network via Obsidian's `requestUrl`.
 *
 * `requestUrl` (not the global `fetch`) is used deliberately — Obsidian's
 * own docs recommend it for plugin network calls because it runs outside
 * the renderer's CORS enforcement, which a plain `fetch()` to an arbitrary
 * member-configured server origin would otherwise be subject to.
 *
 * Endpoints (contract: api/routers/note_sync.py):
 *   POST {serverUrl}/api/j2/notes/connectors/obsidian/redeem
 *   POST {serverUrl}/api/j2/notes/connectors/obsidian/ingest   (Bearer token)
 *   POST {serverUrl}/api/j2/notes/connectors/obsidian/attachments/check   (Bearer token)
 *   PUT  {serverUrl}/api/j2/notes/connectors/obsidian/attachments/{sha256} (Bearer token)
 *
 * Every request carries `X-UCT-Plugin-Version` (`PLUGIN_VERSION_HEADER` in
 * note_sync.py), which the server records per device to know this plugin sends
 * attachment refs.
 */
import { requestUrl } from 'obsidian';
import manifest from '../manifest.json';
import type { IngestRequestBody, IngestResponse, NoteInput, RedeemResponse } from './types';

const REDEEM_PATH = '/api/j2/notes/connectors/obsidian/redeem';
const INGEST_PATH = '/api/j2/notes/connectors/obsidian/ingest';
const ATTACHMENTS_PATH = '/api/j2/notes/connectors/obsidian/attachments';

/** This build's version, from manifest.json (esbuild inlines the JSON). */
export const PLUGIN_VERSION: string = manifest.version;
const VERSION_HEADER = 'X-UCT-Plugin-Version';
const NAME_HEADER = 'X-UCT-Attachment-Name';
/** The server's `_MAX_ATTACHMENT_CHECK_HASHES`: a check over more is a 400. */
export const MAX_CHECK_HASHES = 5000;
/** `ATTACHMENT_PROTOCOL_VERSION` in note_sync.py. */
const ATTACHMENT_PROTOCOL = 1;

export function joinUrl(serverUrl: string, path: string): string {
	const base = serverUrl.replace(/\/+$/, '');
	const suffix = path.startsWith('/') ? path : `/${path}`;
	return `${base}${suffix}`;
}

export interface RedeemParams {
	serverUrl: string;
	code: string;
	vaultId: string;
	label: string | null;
}

export type RedeemOutcome =
	| { ok: true; deviceId: string; token: string; vaultId: string }
	| { ok: false; status: number; message: string };

export interface IngestParams {
	serverUrl: string;
	token: string;
	notes: NoteInput[];
	manifest?: string[];
	final?: boolean;
}

export type IngestOutcome =
	| { ok: true; response: IngestResponse }
	// `authExpired` is true for a 401 specifically — the caller (sync-manager)
	// uses this to distinguish "the token was revoked, tell the member to
	// reconnect" from any other error, which must never loop/retry the same
	// way (see the module docstring on sync-manager.ts).
	| { ok: false; status: number; message: string; authExpired: boolean };

export interface CheckParams {
	serverUrl: string;
	token: string;
	sha256: string[];
}

/** `supported: false` = this server has no attachment routes (an older server, the
 * `NOTE_SYNC_OBSIDIAN_ATTACHMENTS_ENABLED=0` kill switch, an SPA fallback page): the
 * plugin syncs text-only, as 0.1.x did. */
export type CheckOutcome =
	| { ok: true; supported: false }
	| { ok: true; supported: true; missing: string[]; maxBytes: number; remainingBytes: number }
	| { ok: false; status: number; message: string; authExpired: boolean };

export interface UploadParams {
	serverUrl: string;
	token: string;
	sha256: string;
	name: string;
	mime: string;
	data: ArrayBuffer;
}

export type UploadOutcome =
	| { ok: true; stored: boolean }
	| {
		ok: false;
		status: number;
		message: string;
		authExpired: boolean;
		/** 413 naming the member's storage: no later upload this run can fit either. */
		storageFull: boolean;
		/** 429 (the server's in-flight upload cap: 2 per member, 8 per pod), 503
		 * (storage temporarily full, server not configured) or 404/405 (attachments
		 * switched off mid-run): nothing is wrong with this blob; the next sync's check
		 * finds it missing and uploads it again. Never reported as a failure. */
		retryLater: boolean;
	};

export interface Transport {
	redeem(params: RedeemParams): Promise<RedeemOutcome>;
	ingest(params: IngestParams): Promise<IngestOutcome>;
	checkAttachments(params: CheckParams): Promise<CheckOutcome>;
	uploadAttachment(params: UploadParams): Promise<UploadOutcome>;
}

function errorMessage(e: unknown): string {
	return e instanceof Error && e.message ? e.message : String(e);
}

/** A response body as JSON, or undefined (an HTML page, an empty body). Never throws:
 * Obsidian's `res.json` getter throws on a non-JSON body. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `res.json` without its throw: Obsidian's getter throws on a non-JSON body. */
function safeJson(res: { json: unknown }): unknown {
	try {
		return res.json;
	} catch {
		return undefined;
	}
}

const SHA_RE = /^[0-9a-f]{64}$/;
/** `_MAX_ATTACHMENT_NAME_CHARS` in note_sync.py, counted in code points (Python `len`). */
const MAX_NAME_CODE_POINTS = 255;

/**
 * The upload's name, shaped so the server's `note_sync.py::_attachment_name` always
 * accepts it (the server stores the name and never reads it back, so a 400 here would
 * only lose the file): the base name after the last `/`; `\`, every code point below
 * 0x20 and 0x7F become `_`; a lone surrogate becomes U+FFFD (else `encodeURIComponent`
 * throws); over 255 code points it is cut, keeping the extension. `null` (send no
 * header, which the server accepts) for an empty name, `.` or `..`.
 */
export function uploadName(path: string): string | null {
	const base = path.slice(path.lastIndexOf('/') + 1);
	let cps = Array.from(base, (c) => {
		const code = c.codePointAt(0) ?? 0;
		if (c === '\\' || code < 0x20 || code === 0x7f) return '_';
		if (code >= 0xd800 && code <= 0xdfff) return '�';
		return c;
	});
	if (cps.length > MAX_NAME_CODE_POINTS) {
		const dot = cps.lastIndexOf('.');
		const ext = dot > 0 ? cps.slice(dot) : [];
		cps = ext.length < MAX_NAME_CODE_POINTS
			? [...cps.slice(0, MAX_NAME_CODE_POINTS - ext.length), ...ext]
			: cps.slice(0, MAX_NAME_CODE_POINTS);
	}
	const name = cps.join('');
	return name === '' || name === '.' || name === '..' ? null : name;
}

/** Best-effort extraction of FastAPI's `{"detail": "..."}` error shape;
 * falls back to a generic message for anything else (a proxy error page,
 * an empty body, malformed JSON). Never throws. */
function extractDetail(bodyText: string, status: number): string {
	try {
		const parsed = JSON.parse(bodyText) as { detail?: unknown };
		if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail;
	} catch {
		// not JSON — fall through
	}
	return `Request failed (HTTP ${status}).`;
}

export class ObsidianHttpTransport implements Transport {
	// redeem and ingest never throw (Task 9 review, Info 1): a network error is a
	// `status: 0` outcome, and a 2xx whose body is not the expected JSON is a failure,
	// never a crash in the caller.
	async redeem(params: RedeemParams): Promise<RedeemOutcome> {
		let res;
		try {
			res = await requestUrl({
				url: joinUrl(params.serverUrl, REDEEM_PATH),
				method: 'POST',
				contentType: 'application/json',
				throw: false,
				headers: { [VERSION_HEADER]: PLUGIN_VERSION },
				body: JSON.stringify({ code: params.code, vaultId: params.vaultId, label: params.label }),
			});
		} catch (e) {
			return { ok: false, status: 0, message: errorMessage(e) };
		}
		if (res.status >= 200 && res.status < 300) {
			const body = safeJson(res) as Partial<RedeemResponse> | undefined;
			if (isRecord(body) && typeof body.deviceId === 'string' && typeof body.token === 'string'
				&& typeof body.vaultId === 'string') {
				return { ok: true, deviceId: body.deviceId, token: body.token, vaultId: body.vaultId };
			}
			return { ok: false, status: res.status, message: 'Unexpected response from the server.' };
		}
		return { ok: false, status: res.status, message: extractDetail(res.text, res.status) };
	}

	async ingest(params: IngestParams): Promise<IngestOutcome> {
		const body: IngestRequestBody = { consent: true, notes: params.notes };
		if (params.manifest !== undefined) body.manifest = params.manifest;
		if (params.final !== undefined) body.final = params.final;

		let res;
		try {
			res = await requestUrl({
				url: joinUrl(params.serverUrl, INGEST_PATH),
				method: 'POST',
				contentType: 'application/json',
				throw: false,
				headers: { Authorization: `Bearer ${params.token}`, [VERSION_HEADER]: PLUGIN_VERSION },
				body: JSON.stringify(body),
			});
		} catch (e) {
			return { ok: false, status: 0, message: errorMessage(e), authExpired: false };
		}
		if (res.status >= 200 && res.status < 300) {
			const r = safeJson(res);
			if (isRecord(r) && typeof r.written === 'number' && typeof r.skipped === 'number'
				&& typeof r.manifestReplaced === 'boolean' && Array.isArray(r.tooLarge)) {
				return { ok: true, response: r as unknown as IngestResponse };
			}
			return { ok: false, status: res.status, message: 'Unexpected response from the server.', authExpired: false };
		}
		return {
			ok: false,
			status: res.status,
			message: extractDetail(res.text, res.status),
			// A 401 here means EXACTLY one thing per the server contract:
			// the device token is missing/invalid/revoked
			// (`_authenticate_obsidian_device`) — never a transient blip.
			authExpired: res.status === 401,
		};
	}

	/**
	 * Which of `sha256` this device's (member, vault) lacks, plus the server's limits.
	 * Sent in requests of at most `MAX_CHECK_HASHES`; `missing` is concatenated in
	 * request order and the limits are the last response's. An empty list still asks:
	 * that is how the protocol and limits are learned.
	 */
	async checkAttachments(params: CheckParams): Promise<CheckOutcome> {
		const chunks: string[][] = [];
		for (let i = 0; i < params.sha256.length; i += MAX_CHECK_HASHES) {
			chunks.push(params.sha256.slice(i, i + MAX_CHECK_HASHES));
		}
		if (chunks.length === 0) chunks.push([]);
		const missing: string[] = [];
		let limits = { maxBytes: 0, remainingBytes: 0 };
		for (const chunk of chunks) {
			const one = await this.checkOnce(params, chunk);
			if (!one.ok || !one.supported) return one;
			missing.push(...one.missing);
			limits = { maxBytes: one.maxBytes, remainingBytes: one.remainingBytes };
		}
		return { ok: true, supported: true, missing, ...limits };
	}

	private async checkOnce(params: CheckParams, sha256: string[]): Promise<CheckOutcome> {
		let res;
		try {
			res = await requestUrl({
				url: joinUrl(params.serverUrl, `${ATTACHMENTS_PATH}/check`),
				method: 'POST',
				contentType: 'application/json',
				throw: false,
				headers: { Authorization: `Bearer ${params.token}`, [VERSION_HEADER]: PLUGIN_VERSION },
				body: JSON.stringify({ sha256 }),
			});
		} catch (e) {
			return { ok: false, status: 0, message: errorMessage(e), authExpired: false };
		}
		// 404 (no such route, or the attachments flag off) and 405 (a server whose
		// catch-all answers this path for GET only) mean "no attachment support".
		if (res.status === 404 || res.status === 405) return { ok: true, supported: false };
		if (res.status < 200 || res.status >= 300) {
			return {
				ok: false, status: res.status, message: extractDetail(res.text, res.status),
				authExpired: res.status === 401,
			};
		}
		const body = parseJson(res.text);
		// A 2xx that is not protocol 1 (an SPA fallback page, a future protocol) is a
		// server this plugin cannot speak attachments to.
		if (!isRecord(body) || body.protocol !== ATTACHMENT_PROTOCOL) return { ok: true, supported: false };
		const { missing, maxBytes, remainingBytes } = body;
		if (!Array.isArray(missing) || !missing.every((h) => typeof h === 'string')
			|| typeof maxBytes !== 'number' || typeof remainingBytes !== 'number') {
			return { ok: false, status: res.status, message: 'Unexpected attachment check response.', authExpired: false };
		}
		return { ok: true, supported: true, missing: missing as string[], maxBytes, remainingBytes };
	}

	/**
	 * `PUT .../attachments/{sha256}` with the raw bytes. The name header is the BASE
	 * name, percent-encoded: the server decodes it once and refuses a `/` in it.
	 */
	async uploadAttachment(params: UploadParams): Promise<UploadOutcome> {
		if (!SHA_RE.test(params.sha256)) {
			return {
				ok: false, status: 0, message: 'Attachment hash must be 64 lowercase hex characters.',
				authExpired: false, storageFull: false, retryLater: false,
			};
		}
		const name = uploadName(params.name);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${params.token}`,
			[VERSION_HEADER]: PLUGIN_VERSION,
		};
		if (name !== null) headers[NAME_HEADER] = encodeURIComponent(name);
		let res;
		try {
			res = await requestUrl({
				url: joinUrl(params.serverUrl, `${ATTACHMENTS_PATH}/${params.sha256}`),
				method: 'PUT',
				body: params.data,
				contentType: params.mime,
				throw: false,
				headers,
			});
		} catch (e) {
			return {
				ok: false, status: 0, message: errorMessage(e), authExpired: false, storageFull: false, retryLater: false,
			};
		}
		if (res.status >= 200 && res.status < 300) {
			const body = parseJson(res.text);
			if (isRecord(body) && typeof body.stored === 'boolean') return { ok: true, stored: body.stored };
			return {
				ok: false, status: res.status, message: 'Unexpected attachment upload response.',
				authExpired: false, storageFull: false, retryLater: false,
			};
		}
		const message = extractDetail(res.text, res.status);
		return {
			ok: false,
			status: res.status,
			message,
			authExpired: res.status === 401,
			// note_sync.py: a 413 is either the per-file cap ("attachment is too large")
			// or the member's room (`NO_ROOM_DETAIL`, "Your UCT storage ... is full").
			storageFull: res.status === 413 && /storage/i.test(message),
			// 429: the server's in-flight upload cap. 503: storage temporarily full, or not
			// configured. 404/405: attachments switched off (or rolled back) since the
			// check; the next sync's check decides (review M2).
			retryLater: res.status === 429 || res.status === 503 || res.status === 404 || res.status === 405,
		};
	}
}
