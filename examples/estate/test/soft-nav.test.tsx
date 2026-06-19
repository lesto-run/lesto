// @vitest-environment jsdom

/**
 * Client-side soft navigation (ADR 0024) over the file-routed gallery, end to end
 * through the real node app — no real network, no real document navigation.
 *
 * `enableSoftNav` installs a delegated click listener that, for an eligible
 * same-origin `<Link>`, fetches the next page and swaps its body in WITHOUT a full
 * reload. We wire its `fetchPage` seam to the real `app.handle`, so clicking a
 * gallery listing's `<Link>` actually pulls the file-routed `/lab/gallery/:id`
 * detail page and swaps it in — the SPA soft-nav the estate ships. The progressive-
 * enhancement floor (a `<Link>` is a real `<a>`) is proven by the markup itself:
 * the rendered anchors carry an `href` and work with no JS.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { Registry } from "@lesto/ui";
import { enableSoftNav } from "@lesto/ui/client";

import { buildApp } from "../src/app";
import type { LestoResponse } from "@lesto/web";

/** Drain a page's streamed body to a string. */
async function drain(response: LestoResponse): Promise<string> {
  if (typeof response.body === "string") return response.body;

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let html = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    html += decoder.decode(read.value, { stream: true });
  }

  return html + decoder.decode();
}

afterEach(() => {
  document.body.innerHTML = "";
  // Reset the history URL between tests so a pushed entry never leaks forward.
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("soft navigation over the file-routed gallery (ADR 0024)", () => {
  it("renders crawlable <a href> links — the progressive-enhancement floor", async () => {
    const app = await buildApp();

    const html = await drain(await app.handle("GET", "/lab/gallery"));

    // Each listing is a real anchor with an href — it works with JS off.
    expect(html).toContain('<a href="/lab/gallery/bel-air-glen">');
  });

  it("soft-navigates a Link click to the detail page without a full reload", async () => {
    const app = await buildApp();

    // Install the gallery index into the live document (the SSR'd page) and set the
    // browser URL to where it was served, so soft nav seeds its history entry there.
    window.history.replaceState(null, "", "/lab/gallery");
    const indexHtml = await drain(await app.handle("GET", "/lab/gallery"));
    const indexBody = new DOMParser().parseFromString(indexHtml, "text/html").body;
    document.body.replaceChildren(...Array.from(indexBody.childNodes).map((n) => document.importNode(n, true)));

    // Wire soft nav's fetch to the real app — a "navigation" is an app.handle call.
    const fetched: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost:3000").pathname;
      fetched.push(path);

      return { html: await drain(await app.handle("GET", path)), url };
    });

    // A full reload would call this — soft nav must NEVER reach it on a same-origin Link.
    const onError = vi.fn();

    const disable = enableSoftNav(new Registry(), {
      fetchPage,
      onError,
      // jsdom has no real scrollTo; a no-op window keeps the swap clean.
      window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
    });

    // Click the first listing's Link.
    const link = document.querySelector<HTMLAnchorElement>('a[href="/lab/gallery/bel-air-glen"]');
    expect(link).not.toBeNull();

    link?.click();

    // Wait for the SWAP to land (fetch → swap → rehydrate are async after the click).
    await vi.waitFor(() =>
      expect(document.body.innerHTML).toContain('data-file-route="gallery-detail"'),
    );

    // The detail page swapped IN — its content replaced the index, no error path.
    expect(fetched).toContain("/lab/gallery/bel-air-glen");
    expect(document.body.textContent).toContain("Bel Air Glen Estate");
    expect(onError).not.toHaveBeenCalled();

    // History advanced to the detail URL (a pushState, not a document load).
    expect(window.location.pathname).toBe("/lab/gallery/bel-air-glen");

    disable();
  });

  it("replays the previous page on Back (popstate) — history works", async () => {
    const app = await buildApp();

    window.history.replaceState(null, "", "/lab/gallery");
    const indexHtml = await drain(await app.handle("GET", "/lab/gallery"));
    const indexBody = new DOMParser().parseFromString(indexHtml, "text/html").body;
    document.body.replaceChildren(...Array.from(indexBody.childNodes).map((n) => document.importNode(n, true)));

    const fetchPage = vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost:3000").pathname;
      return { html: await drain(await app.handle("GET", path)), url };
    });

    const disable = enableSoftNav(new Registry(), {
      fetchPage,
      window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
    });

    // Forward to the detail page...
    document
      .querySelector<HTMLAnchorElement>('a[href="/lab/gallery/bel-air-glen"]')
      ?.click();
    await vi.waitFor(() =>
      expect(document.body.innerHTML).toContain('data-file-route="gallery-detail"'),
    );

    // ...then Back. jsdom fires popstate on history.back(); soft nav replays the
    // index swap from the entry it pushed.
    window.history.back();
    await vi.waitFor(() =>
      expect(document.body.innerHTML).toContain('data-file-route="gallery-index"'),
    );

    expect(window.location.pathname).toBe("/lab/gallery");

    disable();
  });
});
