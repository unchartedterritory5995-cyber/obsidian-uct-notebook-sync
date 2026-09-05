/**
 * Content hashing. `content_hash` is opaque to the server — it only ever
 * compares a newly-pushed hash against the one already stored for that
 * vault_path (`obsidian_staging.ingest_batch`: "an existing row whose stored
 * content_hash already equals the pushed one is neither rewritten nor its
 * received_at bumped"). SHA-256 hex is used here purely because it is a
 * standard, cheap, collision-safe choice — nothing about the server depends
 * on this specific algorithm.
 */
// Bare "crypto" (not "node:crypto") — esbuild.config.mjs marks Node's
// builtins external by their BARE specifier only (mirrors the official
// obsidianmd/obsidian-sample-plugin scaffold's `external` list); the
// "node:"-prefixed form is a distinct specifier esbuild does not resolve
// the same way and fails the production bundle.
import { createHash as nodeCreateHash } from 'crypto';

/**
 * The exact slice of Node's Hash we use. Declared rather than inferred
 * because the BARE `crypto` specifier above resolves to `any` under a
 * type-aware lint whose module resolution differs from this repo's tsc
 * (Obsidian's directory review reported `no-unsafe-call`,
 * `no-unsafe-member-access` and `no-unsafe-return` on the single line
 * below). Naming the contract is honest about what we depend on and keeps
 * the call typed; it does not change what runs.
 *
 * Node's crypto stays rather than Web Crypto because `subtle.digest` is
 * ASYNC, and `sha256Hex` is called from the synchronous scan/plan path —
 * making it async would ripple through the whole sync planner.
 */
interface Sha256Hasher {
	update(data: string, inputEncoding: 'utf8'): Sha256Hasher;
	digest(encoding: 'hex'): string;
}

const createHash = nodeCreateHash as unknown as (algorithm: string) => Sha256Hasher;

export function sha256Hex(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}
