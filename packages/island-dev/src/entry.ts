/**
 * The dev hydration entry, served by Vite at `/client.js`.
 *
 * It is the SAME synthesized entry `lesto build` ships (`@lesto/assets`'s
 * `synthesizeEntry`) — island registration, the hydrate call, the client error
 * beacon, browser RUM — reused verbatim so dev and prod hydrate through one code
 * path. The only dev delta is `beacon.dev: true`: a hydration error paints the
 * ADR-0011 overlay instead of POSTing to the beacon route. Vite serves this string
 * as a virtual module, transforming it (and every island it imports) with the
 * dialect's Fast-Refresh plugin.
 */

import { synthesizeEntry } from "@lesto/assets";
import type { IslandFile } from "@lesto/assets";

/**
 * Build the dev entry source for a set of islands.
 *
 * Delegates to `synthesizeEntry` with the dev beacon flag set; the islands' absolute
 * `importPath`s become Vite module URLs the browser fetches Fast-Refresh-transformed.
 */
export function devEntrySource(islands: readonly IslandFile[]): string {
  return synthesizeEntry(islands, { dev: true });
}
