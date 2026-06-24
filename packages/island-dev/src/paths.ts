/**
 * The URL contract between the running app's dev dispatch and the Vite island dev
 * server — the one place the "which requests does Vite own?" decision lives.
 *
 * The app's rendered HTML is UNCHANGED by this package (it still emits
 * `<script type="module" src="/client.js">`, ADR 0011), and Vite serves on the SAME
 * origin (`base: "/"`). Two kinds of request are Vite's:
 *
 *   - {@link ENTRY_PATH} (`/client.js`) — the island hydration entry. The app's entry
 *     tag points here; a virtual-module plugin maps it to the synthesized dev entry,
 *     so the browser loads a Fast-Refresh-transformed entry with no HTML rewrite and
 *     no knowledge of the app's private client src. (`vite.transformIndexHtml` may
 *     rewrite the tag to a `/@id/…` virtual URL instead — also owned, see below.)
 *   - anything under a Vite-internal prefix ({@link VITE_PREFIXES}) — the Vite client,
 *     the Fast-Refresh runtime, `@fs`/`@id` module URLs, pre-bundled deps. Island
 *     modules resolve through `/@fs/` (their `importPath` is ABSOLUTE), never a
 *     root-relative `/app/…` URL, so no real app route is ever shadowed.
 *
 * The CLI dev dispatch checks {@link isViteOwnedPath} BEFORE the app (and before the
 * production-shaped `readAsset` passthrough), routing a match to the Vite middleware
 * bridge; a miss falls through to the app exactly as before.
 */

/**
 * The URL the app's hydration entry tag points at (`.client("/client.js")`, the
 * scaffold default and a stable constant). Served by Vite as the synthesized entry.
 */
export const ENTRY_PATH = "/client.js";

/**
 * The path prefixes Vite owns under `base: "/"`. `@fs`/`@id` cover every transformed
 * source module (islands included — their absolute paths route through `/@fs/`);
 * `@vite`/`@react-refresh` are the client + Fast-Refresh runtimes; `/node_modules/`
 * covers pre-bundled deps and symlinked workspace packages.
 */
export const VITE_PREFIXES: readonly string[] = [
  "/@vite/",
  "/@id/",
  "/@fs/",
  "/@react-refresh",
  "/node_modules/",
];

/**
 * Whether a request path is owned by the Vite island dev server rather than the app.
 *
 * A path is Vite's iff it is the entry ({@link ENTRY_PATH}) or starts with a
 * Vite-internal prefix ({@link VITE_PREFIXES}). The query string is ignored — Vite
 * versions module URLs with `?v=`/`?t=`/`?import` suffixes, which still resolve by
 * their pathname.
 */
export function isViteOwnedPath(path: string): boolean {
  const query = path.indexOf("?");
  const pathname = query === -1 ? path : path.slice(0, query);

  if (pathname === ENTRY_PATH) return true;

  return VITE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
