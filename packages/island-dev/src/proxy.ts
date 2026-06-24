/**
 * The pure pieces of the Vite fetch-proxy — extracted here so they are COVERED, since
 * they carry real, load-bearing logic (not the irreducible `fetch`/`vite` IO that
 * lives in the excluded `vite.ts` edge).
 *
 * `viteQuery` is genuinely load-bearing: Lesto's `handle` receives the PATHNAME only
 * (`request.path = url.pathname`), the query split off into `options.query`. Vite
 * versions module URLs (`?v=<hash>`, `?t=<ts>`, `?import`, `?direct`), so the proxy
 * MUST re-attach them or HMR + dep pre-bundling break.
 */

import type { HandleOptions, LestoResponse } from "@lesto/web";

/**
 * Headers `fetch` already consumed when it transparently DECODED the response body —
 * forwarding them would lie about the (now-decoded) bytes' encoding/length and can
 * make a browser mis-read the response. Everything else (`content-type`,
 * `cache-control`, `etag`, `sourcemap`, a redirect `location`) is forwarded.
 */
const FETCH_DECODED_HEADERS = new Set(["content-encoding", "content-length"]);

/**
 * Rebuild the `?…` Vite needs from the parsed query the dev server hands us. Key
 * presence is preserved (a flag like `import` becomes `import=`, which Vite reads
 * identically). Absent/empty query → `""`.
 */
export function viteQuery(query: HandleOptions["query"]): string {
  if (query === undefined) return "";

  const search = new URLSearchParams(query).toString();

  return search === "" ? "" : `?${search}`;
}

/**
 * Adapt a proxied Vite response's headers to a Lesto {@link LestoResponse} header map:
 * forward every header EXCEPT the ones `fetch` already decoded ({@link
 * FETCH_DECODED_HEADERS}), and default a missing `content-type` to JS — Vite serves
 * modules, and a browser refuses a `text/html`-typed (or untyped) module script.
 */
export function proxyHeaders(headers: Headers): LestoResponse["headers"] {
  const out: Record<string, string> = {};

  headers.forEach((value, key) => {
    if (!FETCH_DECODED_HEADERS.has(key)) out[key] = value;
  });

  out["content-type"] ??= "application/javascript";

  return out;
}
