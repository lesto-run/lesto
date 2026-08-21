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

import { act } from "react";

import { ISLAND_ATTR, Registry, UiError } from "@lesto/ui";
import { enableSoftNav, hydrateDocumentIslands, islandDisposer } from "@lesto/ui/client";
import type { Disposer, ObserveFn } from "@lesto/ui/client";

import { buildApp } from "../src/app";
import DeferredPanel from "../app/islands/deferred-panel";
import LiveListing from "../app/islands/live-listing";
import SaveNote from "../app/islands/save-note";
import type { LestoResponse } from "@lesto/web";

/**
 * jsdom has no `IntersectionObserver`, so the `visible` island's observation is
 * injected: it watches nothing and never reports the region seen.
 */
const neverVisible: ObserveFn = () => () => undefined;

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
    document.body.replaceChildren(
      ...Array.from(indexBody.childNodes).map((n) => document.importNode(n, true)),
    );

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
    document.body.replaceChildren(
      ...Array.from(indexBody.childNodes).map((n) => document.importNode(n, true)),
    );

    const fetchPage = vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost:3000").pathname;
      return { html: await drain(await app.handle("GET", path)), url };
    });

    const disable = enableSoftNav(new Registry(), {
      fetchPage,
      window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
    });

    // Forward to the detail page...
    document.querySelector<HTMLAnchorElement>('a[href="/lab/gallery/bel-air-glen"]')?.click();
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

  it("disposes the swapped-out page's islands — the dispose contract (ADR 0048)", async () => {
    // `/lab` carries three real islands. A soft navigation away from it must END
    // them: a detached React root keeps its effects — and a `useQuery` poll or a
    // focus listener registered in one — running for the life of the tab.
    const app = await buildApp();

    // The LiveListing island fetches on mount through the typed client; answer it
    // here so the island mounts deterministically with no real network.
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          Promise.resolve({
            id: "malibu-cliff",
            title: "Malibu Cliff House",
            neighborhood: "Malibu",
            price: 100,
          }),
      } as unknown as Response),
    );

    window.history.replaceState(null, "", "/lab");
    const labHtml = await drain(await app.handle("GET", "/lab"));
    const labBody = new DOMParser().parseFromString(labHtml, "text/html").body;
    document.body.replaceChildren(
      ...Array.from(labBody.childNodes).map((n) => document.importNode(n, true)),
    );

    // The estate island registry, as `client.tsx` builds it — plus the two islands
    // `/lab` adds beyond the marketing header.
    const registry = new Registry()
      .defineClient(LiveListing.island)
      .defineClient(SaveNote.island)
      .defineClient(DeferredPanel.island);

    act(() => {
      hydrateDocumentIslands(registry, { observe: neverVisible });
    });

    // Every island shell on the page now holds a teardown — mounted roots for the
    // eager two, the pending observation for the deferred one.
    const shells = Array.from(document.querySelectorAll(`[${ISLAND_ATTR}]`));
    const handles = shells.map((shell) => islandDisposer(shell));

    expect(shells).toHaveLength(3);
    expect(handles.every((handle) => typeof handle === "function")).toBe(true);

    const disable = enableSoftNav(registry, {
      fetchPage: async (url: string) => {
        const path = new URL(url, "http://localhost:3000").pathname;

        return { html: await drain(await app.handle("GET", path)), url };
      },
      window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
    });

    document.querySelector<HTMLAnchorElement>('a[href="/lab/streaming"]')?.click();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("the listings render resolved"),
    );

    // Each retained handle has already run — the only way a second call raises the
    // coded double-dispose error.
    for (const handle of handles) {
      let caught: unknown;

      try {
        (handle as Disposer)();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UiError);
      expect((caught as UiError).code).toBe("UI_ISLAND_ALREADY_DISPOSED");
    }

    disable();
  });
});
