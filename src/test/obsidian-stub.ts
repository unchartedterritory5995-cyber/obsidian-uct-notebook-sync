/**
 * Test-only stand-in for the real `obsidian` package. The published
 * `obsidian` npm package is TYPES ONLY (`"main": ""`) — it has no runtime
 * JavaScript at all, so Vite/Vitest cannot resolve it as a real module even
 * under `vi.mock`. `vitest.config.ts` aliases the `obsidian` specifier to
 * this file for tests only; production code never sees it (esbuild.config.mjs
 * marks `obsidian` external — the real Obsidian app supplies it at runtime).
 */
import { vi } from 'vitest';

export const requestUrl = vi.fn();

/** Test stand-in for Obsidian's own `TFile`; production uses the real one. */
export class TFile { path = ''; extension = ''; basename = ''; stat = { mtime: 0, size: 0, ctime: 0 }; }

/** Test stand-in for Obsidian's own `parseLinktext`; production uses the real one. */
export function parseLinktext(linktext: string) { const i = linktext.indexOf('#'); return i < 0 ? { path: linktext, subpath: '' } : { path: linktext.slice(0, i), subpath: linktext.slice(i) }; }
