/**
 * The dev hydration entry, in the two forms Vite needs.
 *
 * `devEntrySource` is what Vite SERVES at `/client.js`: the SAME synthesized entry
 * `lesto build` ships (`@lesto/assets`'s `synthesizeEntry`) — island registration, the
 * hydrate call, the client error beacon, browser RUM — reused verbatim so dev and prod
 * hydrate through one code path. The only dev delta is `beacon.dev: true`: a hydration
 * error paints the ADR-0011 overlay instead of POSTing to the beacon route. Vite serves
 * this string as a virtual module, transforming it (and every island it imports) with
 * the dialect's Fast-Refresh plugin.
 *
 * `scanEntrySource` is the same entry written to DISK ({@link SCAN_ENTRY_PATH}) purely
 * so Vite's dep SCANNER has something to seed from — see below. It is never served.
 */

import { synthesizeEntry } from "@lesto/assets";
import type { IslandFile } from "@lesto/assets";
import { dirname, join, relative, sep } from "node:path";

/**
 * Where the scan-only twin of the dev entry is written, relative to the project root.
 *
 * Inside `node_modules` for the same reason Vite's own `node_modules/.vite` cache is:
 * every package manager ignores it, and it is not the app's source. Vite's `globEntries`
 * routes a pattern containing `node_modules` past its own `**\/node_modules/**` ignore,
 * so an entry here is honoured rather than silently dropped.
 */
export const SCAN_ENTRY_PATH = "node_modules/.lesto/island-scan-entry.tsx";

/**
 * Build the dev entry source Vite serves at `/client.js`.
 *
 * Delegates to `synthesizeEntry` with the dev beacon flag set; the islands' absolute
 * `importPath`s become Vite module URLs the browser fetches Fast-Refresh-transformed.
 */
export function devEntrySource(islands: readonly IslandFile[]): string {
  return synthesizeEntry(islands, { dev: true });
}

/**
 * Build the on-disk TWIN of {@link devEntrySource} that Vite's dep scanner reads
 * (`optimizeDeps.entries`, see `config.ts`).
 *
 * WHY THIS EXISTS. The island dev server runs Vite with `appType: "custom"`, a VIRTUAL
 * entry, and no `index.html`. `optimizeDeps.entries` defaults to `**\/*.html`, which
 * matches nothing here — so the dep scanner finds no entry, never runs, and Vite starts
 * the optimizer knowing only `optimizeDeps.include`. Every other npm package the island
 * graph reaches (an island's `clsx`/`lucide-react`, and the entry's own `@lesto/ui` /
 * `@lesto/observability/rum` once Lesto is installed from npm rather than symlinked) is
 * then a mid-crawl discovery: Vite cancels the first optimize, re-runs it, and a racing
 * browser request for a now-stale `?v=` hash 504s ("Outdated Optimize Dep"). Vite's only
 * recovery is an HMR full-reload, which can lose the race against the HMR-WS connect on
 * cold start — the island silently never hydrates (L-90d2de01, follow-up to L-4027e1f0).
 * Pointing the scanner at this file makes the scan and the crawl see ONE graph, so the
 * cold start settles in a single optimizer pass.
 *
 * WHY THE SPECIFIERS ARE REWRITTEN. `synthesizeEntry` imports each island by ABSOLUTE
 * path, which is correct for the served (virtual) entry but INERT for the scanner: its
 * esbuild plugin externalizes any specifier that resolves to itself (`shouldExternalizeDep`:
 * `resolvedId === rawId`), so an absolute island import is never crawled and the scan
 * comes back "no dependencies found" — the exact failure it is meant to prevent, only
 * silently. So the twin imports each island RELATIVE to {@link SCAN_ENTRY_PATH}'s
 * directory. Both forms resolve to the same island modules; only the scanner can tell
 * them apart. Everything else — the bare `@lesto/*` imports, the lazy islands' dynamic
 * `import()` — is byte-identical to what is served, and is derived from the same
 * `synthesizeEntry` call, so the two can never drift in WHICH modules they reach.
 */
export function scanEntrySource(root: string, islands: readonly IslandFile[]): string {
  const scanDir = dirname(join(root, SCAN_ENTRY_PATH));

  return devEntrySource(
    islands.map((island) => ({
      ...island,
      importPath: relativeSpecifier(scanDir, island.importPath),
    })),
  );
}

/**
 * The island's path as a relative module SPECIFIER from `fromDir` — posix separators
 * (a Windows `..\..\app` is not a module specifier), and always dot-prefixed, since a
 * bare `app/islands/x.tsx` would resolve as a PACKAGE name, not a sibling file.
 */
function relativeSpecifier(fromDir: string, importPath: string): string {
  const path = relative(fromDir, importPath).split(sep).join("/");

  return path.startsWith(".") ? path : `./${path}`;
}
