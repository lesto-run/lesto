import { outputPath, sitePath } from "./paths";
import type { LestoResponseBody, PageHandler, RenderedPage, StaticSite } from "./types";

/** Resolve a static site's pages, whether they were a list or a function. */
async function resolvePages(site: StaticSite): Promise<readonly string[]> {
  return typeof site.pages === "function" ? site.pages() : site.pages;
}

/**
 * Drain a response body to its raw bytes, whatever arm the handler produced.
 *
 * Prerendering is "run the live handler and capture its bytes" — but the body
 * can arrive as a string, raw bytes, or a stream. The framework's `.page` routes
 * stream React SSR as a `ReadableStream<Uint8Array>`, so a static build of a
 * `.page` route only works if we read that stream to completion here. We return
 * **bytes** (not a string) so a binary route — a generated PNG, a font — is
 * never decoded-then-reencoded into corruption on its way to the sink. Each arm:
 *
 *   - `undefined` → an empty byte array. No body (a 204, say) becomes an empty
 *     file, not the string `"undefined"`.
 *   - `string` → UTF-8-encoded. This is the hot HTML path, checked first.
 *   - `Uint8Array` → returned verbatim, byte for byte — the whole point.
 *   - `ReadableStream<Uint8Array>` → read chunk by chunk to exhaustion and
 *     concatenated, so the bytes land in arrival order with no transcoding.
 */
async function bodyToBytes(body: LestoResponseBody): Promise<Uint8Array> {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  // `read()`'s result is a discriminated union — `done: true` carries no value,
  // `done: false` always carries a chunk — so narrowing on the whole result (not
  // a pre-destructured `value`) lets TypeScript know `result.value` is defined
  // here, satisfying `noUncheckedIndexedAccess` without an untestable guard.
  for (let result = await reader.read(); !result.done; result = await reader.read()) {
    chunks.push(result.value);
    total += result.value.length;
  }

  // Concatenate the chunks verbatim — no decode, so multi-byte sequences split
  // across chunk boundaries (and any non-text payload) survive intact.
  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

/**
 * Prerender a static site by asking the app to render each page.
 *
 * This is the keystone: a static site is the dynamic app, rendered offline. For
 * each route we call the app's own `handle("GET", path)` — the exact code path a
 * live request takes — and capture the HTML and its status, so the build can
 * fail on a page the app could not render.
 */
export async function prerenderSite(
  site: StaticSite,
  handle: PageHandler,
): Promise<RenderedPage[]> {
  const routes = await resolvePages(site);

  const pages: RenderedPage[] = [];

  for (const route of routes) {
    const path = sitePath(site.basePath, route);
    const response = await handle("GET", path);

    // Capture the raw bytes the handler produced — buffering a stream to
    // completion so a `.page` route's streamed SSR (and any binary route) lands
    // byte-identical. `html` is a UTF-8 view of those bytes for the common text
    // case; the sink writes `body`, so a binary route is never corrupted.
    const body = await bodyToBytes(response.body);

    pages.push({
      path,
      outputPath: outputPath(site.name, route),
      status: response.status,
      body,
      html: new TextDecoder().decode(body),
    });
  }

  return pages;
}
