/**
 * Server URL validation. The member types this by hand, so every refusal
 * says exactly what to type instead. A valid address normalizes to its
 * origin (scheme + host + port, no path, no trailing slash).
 */
export type ServerUrlResult = { ok: true; url: string } | { ok: false; message: string };

const EXAMPLE = 'https://uctintelligence.com';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function validateServerUrl(raw: string): ServerUrlResult {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) {
		return { ok: false, message: `Enter your UCT address, for example ${EXAMPLE}` };
	}
	const notWeb = {
		ok: false as const,
		message: `That isn't a web address. Use the address you open UCT at, for example ${EXAMPLE}`,
	};
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return notWeb;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return notWeb;
	if (parsed.username || parsed.password) {
		return { ok: false, message: `Remove the username and password from the address, for example ${EXAMPLE}` };
	}
	if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname)) {
		return { ok: false, message: `Use https:// for this address, for example ${EXAMPLE}` };
	}
	return { ok: true, url: parsed.origin };
}
