/**
 * The URL contract between the running app's dev dispatch and the Vite island dev
 * server — the one place the "which requests does Vite own?" decision lives.
 *
 * Vite is configured with a dedicated `base` ({@link VITE_BASE}), so EVERY URL it
 * serves — the entry, island modules, the Vite client, the Fast-Refresh runtime,
 * pre-bundled deps — sits under that one prefix. (Critically: island modules live
 * INSIDE the project root, so Vite serves them as ROOT-RELATIVE URLs, not `/@fs/`;
 * a dedicated base is what makes that whole set ownable by a single prefix and keeps
 * it from ever shadowing a real app route.) `vite.transformIndexHtml` even rewrites
 * the app's existing `<script src="/client.js">` to `<base>client.js`, so the app's
 * HTML needs no change and the browser only ever requests `<base>…` URLs.
 *
 * The CLI dev dispatch checks {@link isViteOwnedPath} BEFORE the app (and before the
 * production-shaped `readAsset` passthrough), routing a match to the Vite proxy; a
 * miss falls through to the app exactly as before.
 */

/** The base prefix Vite serves all of its URLs under (its `config.base`). */
export const VITE_BASE = "/@lesto-dev/";

/**
 * The id the synthesized dev entry is resolved by — the app's `.client("/client.js")`
 * src (the scaffold default, a stable constant). Vite strips {@link VITE_BASE} before
 * resolving, so the virtual-entry plugin claims this bare path; the browser only ever
 * requests it base-prefixed (`<base>client.js`). Not part of {@link isViteOwnedPath}:
 * the bare `/client.js` is never requested once `transformIndexHtml` base-prefixes it.
 */
export const ENTRY_PATH = "/client.js";

/**
 * Whether a request path is owned by the Vite island dev server rather than the app.
 *
 * A path is Vite's iff it sits under {@link VITE_BASE} — a single, collision-proof
 * prefix no real app route can start with. The query string (`?v=`/`?t=`/`?import`)
 * is irrelevant: it never precedes the base.
 */
export function isViteOwnedPath(path: string): boolean {
  return path.startsWith(VITE_BASE);
}
