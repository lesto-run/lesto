import { outputPath, sitePath } from "./paths";
import type { KeelResponseBody, PageHandler, RenderedPage, StaticSite } from "./types";

/** Resolve a static site's pages, whether they were a list or a function. */
async function resolvePages(site: StaticSite): Promise<readonly string[]> {
  return typeof site.pages === "function" ? site.pages() : site.pages;
}

/**
 * Drain a response body to a string, whatever arm the handler produced.
 *
 * Prerendering is "run the live handler and capture its bytes" — but the bytes
 * can arrive as a string, raw bytes, or a stream. The framework's `.page` routes
 * stream React SSR as a `ReadableStream<Uint8Array>`, so a static build of a
 * `.page` route only works if we read that stream to completion here. Each arm:
 *
 *   - `undefined` → `""`. No body (a 204, say) becomes an empty file, not the
 *     string `"undefined"`.
 *   - `string` → returned verbatim, byte for byte. This is the hot path and must
 *     stay identical to the pre-stream behavior, so it is checked first.
 *   - `Uint8Array` → decoded as UTF-8 in one shot.
 *   - `ReadableStream<Uint8Array>` → read chunk by chunk to exhaustion. We decode
 *     incrementally with `{ stream: true }` so a multi-byte UTF-8 sequence split
 *     across two chunks still decodes correctly, then a final flushing `decode()`
 *     emits any trailing partial sequence as the replacement character.
 */
async function bodyToString(body: KeelResponseBody): Promise<string> {
  if (body === undefined) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = "";

  // `read()`'s result is a discriminated union — `done: true` carries no value,
  // `done: false` always carries a chunk — so narrowing on the whole result (not
  // a pre-destructured `value`) lets TypeScript know `result.value` is defined
  // here, satisfying `noUncheckedIndexedAccess` without an untestable guard.
  for (let result = await reader.read(); !result.done; result = await reader.read()) {
    html += decoder.decode(result.value, { stream: true });
  }

  // Flush any bytes the streaming decoder was holding for a split sequence.
  html += decoder.decode();

  return html;
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

    pages.push({
      path,
      outputPath: outputPath(site.name, route),
      status: response.status,
      // Capture the bytes the handler produced — buffering a stream to completion
      // so a `.page` route's streamed SSR lands on disk as HTML, not `[object …]`.
      html: await bodyToString(response.body),
    });
  }

  return pages;
}
