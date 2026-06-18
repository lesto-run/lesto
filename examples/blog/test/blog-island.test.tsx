// @vitest-environment jsdom

/**
 * The blog proof (ADR 0011 Increment 1 exit, demonstrating ADR 0012).
 *
 * `examples/blog` is the canonical `volo()+.page` app. This proves the CANONICAL
 * island end to end: an `ssr: true` island with INLINE data on the dynamically
 * rendered `/posts` page — server markup carrying the real counts, a co-located
 * mount script with the data inlined and no `bind`, no primer, the head module
 * tag — and a jsdom `hydrateDocumentIslands` pass that mounts it with zero
 * `failed`. The data route's `shared` cache header is asserted too.
 *
 * No bespoke scripts: the page is `volo()+.page` + one island file (review F8 —
 * no casts). The automated assertions here are the gate; a real browser run is
 * the smoke (recorded in the commit, not runnable headlessly).
 */

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Registry } from "@volo/ui";
import { hydrateDocumentIslands } from "@volo/ui/client";
import { openSqlite } from "@volo/runtime";
import type { App } from "@volo/kernel";
import type { Db } from "@volo/db";

import ReactionsIsland from "../app/islands/reactions";
import { buildApp } from "../src/app";
import { insertPost } from "../src/post";

const SEEDS = [
  { title: "Hello, Volo", body: "First post body." },
  { title: "One substrate", body: "Second post body, a bit longer." },
];

/** Boot the blog over an in-memory SQLite DB, seed two posts, return app + teardown. */
async function bootBlog(): Promise<{ app: App; db: Db; close: () => void }> {
  const { db: handle, close } = await openSqlite();

  const { app, db } = await buildApp(handle);

  for (const seed of SEEDS) await insertPost(db, seed);

  return { app, db, close };
}

/** Drain a streamed response body to a single string. */
async function drain(body: unknown): Promise<string> {
  return new Response(body as BodyInit).text();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("blog /posts — the canonical island", () => {
  it("streams the island's real markup with inline data, a mount script, no primer, the head tag", async () => {
    const { app, close } = await bootBlog();

    try {
      const response = await app.handle("GET", "/posts");

      expect(response.status).toBe(200);

      const html = await drain(response.body);

      // (a) the island's REAL server markup, including the counts — the reaction
      // badges carry the per-post like counts (body length: 16 and 31). The
      // adjacent-text `<!-- -->` markers are React's (renderToString) and are
      // exactly what makes hydration align, so we assert the digits are present
      // in the badge, not a marker-free string.
      expect(html).toContain('class="reactions"');
      expect(html).toContain('data-slug="post-1"');
      expect(html).toContain('data-slug="post-2"');
      expect(html).toMatch(/data-slug="post-1"[^>]*>👍 <!-- -->16</);
      expect(html).toMatch(/data-slug="post-2"[^>]*>👍 <!-- -->31</);
      // It is the real component, not a fallback (there is none).
      expect(html).toContain("aria-pressed");

      // (b) a co-located mount script with the data inlined and NO bind.
      expect(html).toContain("data-volo-island-mount");
      expect(html).toContain('"ssr":true');
      expect(html).toContain('"counts":{"post-1":16,"post-2":31}');
      expect(html).not.toContain('"bind"');

      // (c) no primer — the data crossed the wire inline.
      expect(html).not.toContain("__voloData");

      // (d) the head module tag that boots hydration.
      expect(html).toContain('<script type="module" src="/client.js"></script>');
      expect(html.indexOf("/client.js")).toBeLessThan(html.indexOf("<body>"));
    } finally {
      close();
    }
  });

  it("answers /__volo/data/reactions with the shared cache header", async () => {
    const { app, close } = await bootBlog();

    try {
      const response = await app.handle("GET", "/__volo/data/reactions");

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
      expect(JSON.parse(response.body)).toEqual({ "post-1": 16, "post-2": 31 });
    } finally {
      close();
    }
  });

  it("hydrates the island in jsdom with zero failures", async () => {
    const { app, close } = await bootBlog();

    try {
      const html = await drain((await app.handle("GET", "/posts")).body);

      // Drop the streamed document into jsdom (body content is enough for the
      // shell + its co-located mount script).
      document.body.innerHTML = html.slice(html.indexOf("<body>") + "<body>".length);

      // The client registry knows the island by the name in its mount script.
      const registry = new Registry().defineClient(ReactionsIsland.island);

      let result!: ReturnType<typeof hydrateDocumentIslands>;
      act(() => {
        result = hydrateDocumentIslands(registry);
      });

      // The canonical island hydrates synchronously (ssr + inline data, no bind):
      // mounted, nothing failed, nothing deferred.
      expect(result.failed).toEqual([]);
      expect(result.mounted).toHaveLength(1);
      expect(result.deferred).toEqual([]);

      // The interactive toggle is live after hydration — the proof it hydrated,
      // not merely painted: clicking it bumps the count.
      const button = document.querySelector<HTMLButtonElement>('.reaction[data-slug="post-1"]')!;
      expect(button.textContent).toContain("16");

      act(() => {
        button.click();
      });

      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.textContent).toContain("17");
    } finally {
      close();
    }
  });
});
