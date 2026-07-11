/**
 * Path-mount serving: one origin, many sites, dispatched by path prefix.
 *
 * A Lesto deployment serves a *set* of sites from a single origin — a marketing
 * site at `/`, an authed app at `/mls` — so they share an origin and therefore a
 * same-origin session. This dispatcher is the front door: it picks the site that
 * owns the request path, then serves it. Dynamic sites delegate to the live app;
 * static sites read their prerendered file off a sink.
 *
 * It is deliberately pure. The one thing that varies — reading a static file —
 * is injected as `readStatic`, so the whole decision tree is testable against a
 * fake map with no disk. The real filesystem reader ({@link nodeStaticReader})
 * is a thin, separately-tested adapter over that same shape.
 */

import { outputPath } from "@lesto/sites";
import type { Site } from "@lesto/sites";

import type { AnyLestoResponse, LestoResponse } from "@lesto/web";

import { cacheControl, hasContentHash } from "./http-cache";

/**
 * Reads a prerendered file's contents, or `undefined` if it is not there.
 *
 * The body widens to `string | Uint8Array`: a text file (HTML, CSS, a JSON feed)
 * still comes back as a `string`, exactly as before, so every existing reader
 * keeps working unchanged; a binary file (an image, a font, a PDF) comes back as
 * raw bytes a `string` would have corrupted. A reader is free to return either —
 * the dispatcher labels the response from the file's extension, not its body
 * kind, so the two never disagree.
 */
export type StaticReader = (filePath: string) => Promise<string | Uint8Array | undefined>;

/** The per-request inputs a dynamic site needs threaded through to it. */
export interface RequestOptions {
  readonly query?: Record<string, string>;

  readonly headers?: Record<string, string>;

  readonly body?: unknown;

  readonly rawBody?: string;

  /**
   * The exact undecoded request bytes — the byte-exact companion to
   * {@link RequestOptions.rawBody}. See `@lesto/web`'s `HandleOptions.rawBytes`.
   *
   * The multi-site dispatcher forwards `options` verbatim to a dynamic site's
   * `AppHandler` (never decoding or re-encoding it), so this rides through
   * unchanged — a binary webhook mounted behind a zone (e.g. `/mls/webhook`)
   * can verify its HMAC over the SAME bytes the transport captured, never a
   * lossy UTF-8 round trip through {@link RequestOptions.rawBody}.
   */
  readonly rawBytes?: Uint8Array;
}

/**
 * The live app's request handler, for dynamic sites.
 *
 * It takes the request options (query, headers, body) and returns the *full*
 * {@link LestoResponse} — status, headers, and body — which the dispatcher passes
 * through verbatim in both directions. That is load-bearing: a dynamic zone
 * reads the session cookie from the request `headers` and sets it via the
 * response `Set-Cookie`, so neither may be dropped. `App.handle` from
 * `@lesto/kernel` satisfies this exactly, which is why the dispatcher this builds
 * stays assignable to the same string-bodied handler contract `serve` fronts.
 */
export type AppHandler = (
  method: string,
  path: string,
  options?: RequestOptions,
) => Promise<LestoResponse>;

/** Everything the site dispatcher needs, injected so the core stays pure. */
export interface DispatchSitesDeps {
  /** The mounted sites, in any order — selection is by longest matching prefix. */
  readonly sites: readonly Site[];

  /** The live app's request handler, for dynamic sites. Pass `app.handle`. */
  readonly handle: AppHandler;

  /** Reads a prerendered static file by its output path. */
  readonly readStatic: StaticReader;

  /**
   * Whether to serve source-map files (`*.map`). Off by default: a source map
   * shipped to production hands an attacker the original source. Build output
   * may carry maps, so we refuse any `.map` request unless this is explicitly
   * enabled — production should not. A refused map is a bare 404, identical to a
   * missing file, so its presence on disk never leaks. (The dev dispatcher,
   * which has its own asset passthrough, serves maps for debugging.)
   */
  readonly serveSourceMaps?: boolean;
}

/** The methods a static site answers; anything else is a 405. */
const STATIC_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** The framework's reserved path namespace, always served by the live app (ADR 0010). */
const FRAMEWORK_RESERVED_PREFIX = "/__lesto/";

/**
 * One row of the content-type table: the MIME type, and whether it is binary.
 *
 * `binary: true` means the bytes are not text and a `string` would corrupt them
 * (an image, a font, a PDF, WASM) — the dispatcher serves such a file as raw
 * `Uint8Array`. `binary: false` is text (HTML, CSS, JS, a JSON feed), served as
 * a `string` exactly as before. WASM is the one binary type with a `charset`-free
 * `application/` MIME, so the flag — not the MIME shape — is the source of truth.
 */
interface ContentType {
  readonly type: string;

  readonly binary: boolean;
}

/**
 * The extension → content-type table, the single source both dispatchers share.
 *
 * Text types keep their exact prior values (so existing behavior is byte-for-
 * byte unchanged); the binary types are the common static-asset set an app
 * actually serves — images, fonts, media, documents, WASM. The map is keyed by
 * the dotted extension and consulted longest-first by {@link lookupContentType},
 * so `.woff2` is never shadowed by a hypothetical `.woff`-suffix match.
 */
const CONTENT_TYPES: ReadonlyMap<string, ContentType> = new Map([
  // Text — the original set, values unchanged.
  [".js", { type: "text/javascript; charset=utf-8", binary: false }],
  [".css", { type: "text/css; charset=utf-8", binary: false }],
  [".xml", { type: "application/xml", binary: false }],
  [".txt", { type: "text/plain; charset=utf-8", binary: false }],
  // A source map is JSON; group it with the `.json` feed case.
  [".map", { type: "application/json", binary: false }],
  [".json", { type: "application/json", binary: false }],
  // SVG is XML text, not raster bytes — served as a string, like the other markup.
  [".svg", { type: "image/svg+xml; charset=utf-8", binary: false }],
  // Images.
  [".png", { type: "image/png", binary: true }],
  [".jpg", { type: "image/jpeg", binary: true }],
  [".jpeg", { type: "image/jpeg", binary: true }],
  [".gif", { type: "image/gif", binary: true }],
  [".webp", { type: "image/webp", binary: true }],
  [".avif", { type: "image/avif", binary: true }],
  [".ico", { type: "image/x-icon", binary: true }],
  // Fonts.
  [".woff", { type: "font/woff", binary: true }],
  [".woff2", { type: "font/woff2", binary: true }],
  [".ttf", { type: "font/ttf", binary: true }],
  [".otf", { type: "font/otf", binary: true }],
  // Documents and media.
  [".pdf", { type: "application/pdf", binary: true }],
  [".mp4", { type: "video/mp4", binary: true }],
  [".webm", { type: "video/webm", binary: true }],
  // WebAssembly — binary, with the MIME the browser needs to stream-compile it.
  [".wasm", { type: "application/wasm", binary: true }],
]);

/**
 * The fallback for any extension not in the table: an HTML page.
 *
 * A clean-URL page is always `index.html`, and an unrecognized path is most
 * likely a page route, so HTML is the safe default — and it is text, never bytes.
 */
const DEFAULT_CONTENT_TYPE: ContentType = { type: "text/html; charset=utf-8", binary: false };

/**
 * Resolve a file's content-type row from its extension.
 *
 * Matched case-insensitively (a file may be `LOGO.PNG`) against the table's
 * dotted extensions. No registered extension is a suffix of another — `.woff`
 * and `.woff2` differ in their final character, so `name.woff2` ends with only
 * `.woff2` — so the first match is unambiguous. An unknown extension falls back
 * to HTML (text), the clean-URL page common case.
 */
function lookupContentType(filePath: string): ContentType {
  const lower = filePath.toLowerCase();

  for (const [extension, row] of CONTENT_TYPES) {
    if (lower.endsWith(extension)) {
      return row;
    }
  }

  return DEFAULT_CONTENT_TYPE;
}

/**
 * Pick a `Content-Type` from a file's extension.
 *
 * Two kinds of file flow through here, and one table serves both. Prerendered
 * pages are HTML plus a handful of endpoints (`sitemap.xml`, `robots.txt`, a
 * JSON feed); build assets are scripts, styles, images, fonts, media, and WASM.
 * Each known extension maps to its type; anything unrecognized is HTML — the
 * page common case, since a clean-URL page is always `index.html`.
 *
 * Exported because the dev dispatcher serves the very same file kinds (a `.js`
 * island bundle, a `.css` sheet, a `.png`) and must label them identically — one
 * table, not two that can drift.
 */
export function contentTypeOf(filePath: string): string {
  return lookupContentType(filePath).type;
}

/**
 * True iff a file's bytes are binary — not safe to round-trip through a string.
 *
 * The dispatcher uses this to decide how to read and serve a static file: a
 * binary file is served as raw `Uint8Array` (an image a `string` would mangle),
 * a text file as a `string` (the original path). Exported so the dev dispatcher
 * makes the same call from the same table.
 */
export function isBinaryType(filePath: string): boolean {
  return lookupContentType(filePath).binary;
}

/**
 * Select the site that owns a request path.
 *
 * The winner is the site whose `basePath` is the *longest* prefix of the path
 * that lands on a segment boundary — so `/mls/x` picks `mls` over the root, and
 * a `basePath` of `/ml` never claims `/mls`. `basePath: "/"` is the catch-all,
 * matching anything no more specific site has claimed.
 *
 * Exported so the dev dispatcher selects by the exact same rule — shared code,
 * never a copy that could drift from production's boundary semantics.
 */
export function selectSite(sites: readonly Site[], path: string): Site | undefined {
  let best: Site | undefined;

  for (const site of sites) {
    const { basePath } = site;

    // The root mount matches every path; it is the floor everything falls to.
    const matches = basePath === "/" || path === basePath || path.startsWith(`${basePath}/`);

    if (!matches) continue;

    // Longer basePath wins; the root's length of 1 loses to any real zone.
    if (best === undefined || basePath.length > best.basePath.length) {
      best = site;
    }
  }

  return best;
}

/**
 * Strip a site's `basePath` from a path to get the route *within* the site.
 *
 *   ("/mls", "/mls/about") -> "/about"
 *   ("/mls", "/mls")       -> "/"
 *   ("/",    "/about")     -> "/about"
 *   ("/",    "/")          -> "/"
 */
function routeWithin(basePath: string, path: string): string {
  if (basePath === "/") return path;

  const rest = path.slice(basePath.length);

  // `/mls` exactly leaves nothing; that is the site's own root, `/`.
  return rest === "" ? "/" : rest;
}

/** A bare-bones response with no body — for the error statuses. */
function emptyResponse(status: number): LestoResponse {
  return { status, headers: {}, body: "" };
}

/**
 * Present a (possibly-binary) static response under the string-bodied handler
 * contract the rest of the stack shares.
 *
 * The dispatch contract (`LestoResponse`, the kernel's `App.handle`, what `serve`
 * fronts) is string-bodied — and we cannot widen it without editing `@lesto/web`'s
 * consumers in the kernel. But a static file may legitimately be *bytes* (an
 * image), so `serveStatic` produces an {@link AnyLestoResponse}. This is the one
 * seam where the two meet: the cast is true at runtime because every body
 * consumer downstream — `applyResponse`, `withEtag`, the edge adapter — inspects
 * the body *kind* at runtime (`typeof` / `instanceof`) and writes bytes as bytes.
 * The type merely under-describes the body; the value is handled correctly.
 */
function asHandlerResponse(response: AnyLestoResponse): LestoResponse {
  return response as LestoResponse;
}

/**
 * Coerce a read static file's body to the kind its content-type expects.
 *
 * The reader may hand back either arm — `nodeStaticReader` reads every file as
 * bytes (so a binary file is never corrupted by a UTF-8 round trip), while a
 * test fake might return a string. The *extension* is the authority on how the
 * file should be served, so we reconcile the two here:
 *
 *   - A binary type (an image, a font) must go out as raw bytes; a string the
 *     reader handed us is encoded back to a `Buffer` so nothing is mangled.
 *   - A text type (HTML, CSS, a JSON feed) goes out as a string; bytes the
 *     reader handed us are decoded as UTF-8 — the original static behavior.
 *
 * This is why body kind and `Content-Type` can never disagree: one function
 * decides both from the same extension.
 */
function staticBody(file: string, body: string | Uint8Array): string | Uint8Array {
  if (isBinaryType(file)) {
    return typeof body === "string" ? Buffer.from(body) : body;
  }

  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

/**
 * The `Cache-Control` a prerendered file gets, by whether its URL is frozen.
 *
 * A content-hashed asset (`app.4f3a9c2b.js`) is content-addressed: its bytes can
 * never change under that URL, so it is cached `immutable` for a year and never
 * revalidated — the single biggest repeat-visit win. Everything else (a page's
 * `index.html`, a hand-named asset, `sitemap.xml`) may change at the same URL,
 * so it is `no-cache`: stored, but revalidated every time. An HTML revalidation
 * that finds no change is cheap because the dynamic path pairs it with an ETag;
 * a static page revalidates against the file's freshness on the next request.
 *
 * Exported so a test can assert the policy directly, and so the dev dispatcher
 * could label assets identically if it ever needs to — one table, not two.
 */
export function staticCacheControl(filePath: string): string {
  return hasContentHash(filePath)
    ? cacheControl({ immutable: true })
    : cacheControl({ noCache: true });
}

/** Serve a static site: only GET/HEAD, mapping the route to its prerendered file. */
async function serveStatic(
  site: Site,
  method: string,
  path: string,
  readStatic: StaticReader,
  serveSourceMaps: boolean,
): Promise<AnyLestoResponse> {
  if (!STATIC_METHODS.has(method)) return emptyResponse(405);

  const route = routeWithin(site.basePath, path);

  // Build and serve must agree on where a route's file lives, so both call
  // `outputPath` from @lesto/sites — the single source of that mapping.
  const file = outputPath(site.name, route);

  // A source map is build debug output; serving it in production leaks source.
  // Refuse it as a bare 404 (indistinguishable from a missing file) unless the
  // deployment explicitly opts in, so a map that slipped into the output dir is
  // never disclosed and its existence is never even observable.
  if (!serveSourceMaps && file.endsWith(".map")) return emptyResponse(404);

  const body = await readStatic(file);

  if (body === undefined) return emptyResponse(404);

  return {
    status: 200,
    headers: {
      "content-type": contentTypeOf(file),
      // Freeze content-hashed assets for a year; make pages revalidate.
      "cache-control": staticCacheControl(file),
    },
    // Bytes for a binary file, a string for text — decided from the extension,
    // so the body kind always matches the Content-Type above.
    body: staticBody(file, body),
  };
}

/**
 * Build the path-mount dispatcher over a set of sites.
 *
 * Returns a handler `(method, path) -> response`: select the owning site, then
 * delegate (dynamic) or read its prerendered file (static). No owning site is a
 * 404 — the request belongs to no mounted zone.
 */
export function dispatchSites(
  deps: DispatchSitesDeps,
): (method: string, path: string, options?: RequestOptions) => Promise<LestoResponse> {
  const { sites, handle, readStatic } = deps;
  const serveSourceMaps = deps.serveSourceMaps ?? false;

  return async (method, path, options) => {
    // `/__lesto/*` is the framework's reserved namespace (island data sources —
    // ADR 0010 — and any future framework route). It is always served by the
    // live app, never matched against a zone: a data endpoint must resolve the
    // same under node serve as under the edge's asset-then-app fallthrough, even
    // though the `/` catch-all zone's prefix would otherwise claim it.
    if (path.startsWith(FRAMEWORK_RESERVED_PREFIX)) return handle(method, path, options);

    const site = selectSite(sites, path);

    if (site === undefined) return emptyResponse(404);

    // A dynamic zone delegates to the live app, verbatim — the request options
    // (query, headers, body, rawBody/rawBytes) flow in unmodified and the full
    // response, `Set-Cookie` and all, flows back. That round trip is what
    // carries the same-origin session AND lets a mounted webhook verify its
    // HMAC over the byte-exact `rawBytes`, never a re-serialized body.
    if (site.render === "dynamic") return handle(method, path, options);

    // A static file may be bytes (an image); the handler contract is string-
    // bodied, so present it as such — the runtime writes the real bytes. See
    // {@link asHandlerResponse}.
    return asHandlerResponse(await serveStatic(site, method, path, readStatic, serveSourceMaps));
  };
}
