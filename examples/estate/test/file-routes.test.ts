/**
 * File-based routing (ADR 0023) driven through the real node app, plus a proof
 * that the GENERATED manifest (`src/routes.gen.ts`, emitted by
 * `generateRouteManifest` from `app/routes/`) names exactly what a REAL
 * `scanRoutes` over the on-disk tree discovers — so the committed manifest can
 * never silently drift from the files (`build.ts` regenerates it).
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanRoutes } from "@lesto/router";
import type { DirEntry } from "@lesto/router";
import { generateRouteManifest } from "@lesto/web";
import type { LestoResponse } from "@lesto/web";

import { buildApp } from "../src/app";

/** Drain a page's streamed body (or pass a string body through) for assertions. */
async function body(response: LestoResponse): Promise<string> {
  if (typeof response.body === "string") return response.body;

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let out = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    out += decoder.decode(read.value, { stream: true });
  }

  return out + decoder.decode();
}

/** A real filesystem DirReader over the project's `app/routes/` convention dir. */
const nodeReader = async (path: string): Promise<readonly DirEntry[]> => {
  const entries = await readdir(path, { withFileTypes: true });

  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
};

describe("file-based routing — the committed manifest is fresh", () => {
  it("src/routes.gen.ts is byte-identical to a fresh generation from app/routes/", async () => {
    const routesDir = fileURLToPath(new URL("../app/routes", import.meta.url));

    const scanned = await scanRoutes(nodeReader, routesDir);
    const fresh = generateRouteManifest(scanned, { importBase: "../app/routes" });
    const committed = await readFile(
      fileURLToPath(new URL("../src/routes.gen.ts", import.meta.url)),
      "utf8",
    );

    // The committed manifest must equal what the codegen produces from the on-disk
    // tree RIGHT NOW — so a route file added/removed/renamed (or a stale import or
    // map entry) fails loudly here, not silently at deploy. `build.ts` regenerates
    // this file; this guard is what keeps the checked-in copy honest.
    expect(committed).toBe(fresh);
  });
});

describe("file-based routing — registered routes work (ADR 0023)", () => {
  it("serves the file-routed gallery index at /lab/gallery", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/gallery");
    expect(response.status).toBe(200);

    const html = await body(response);

    expect(html).toContain('data-file-route="gallery-index"');
    // Every listing links to its detail page.
    expect(html).toContain('href="/lab/gallery/bel-air-glen"');
  });

  it("serves the dynamic [id] page with a typed param at /lab/gallery/:id", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/gallery/bel-air-glen");
    expect(response.status).toBe(200);

    const html = await body(response);

    expect(html).toContain('data-file-route="gallery-detail"');
    expect(html).toContain("Bel Air Glen Estate");
    // The typed `:id` flowed through the page's load into the rendered markup.
    expect(html).toContain('<code data-param-id="true">bel-air-glen</code>');
  });

  it("wraps every file-routed page in the convention's root layout.tsx", async () => {
    const app = await buildApp();

    const html = await body(await app.handle("GET", "/lab/gallery"));

    // The root layout frame wraps the page.
    expect(html).toContain('data-file-route-layout="root"');
    // ...outside the page content.
    const layoutAt = html.indexOf('data-file-route-layout="root"');
    const pageAt = html.indexOf('data-file-route="gallery-index"');
    expect(layoutAt).toBeGreaterThanOrEqual(0);
    expect(layoutAt).toBeLessThan(pageAt);
  });

  it("renders a graceful not-found view for an unknown listing id", async () => {
    const app = await buildApp();

    const html = await body(await app.handle("GET", "/lab/gallery/no-such-id"));

    expect(html).toContain('data-file-route="gallery-detail-missing"');
    expect(html).toContain("no-such-id");
  });

  it("co-exists with the hand-written lab routes on one router", async () => {
    const app = await buildApp();

    // A file-routed page AND a programmatic one both answer 200 on the same app —
    // the convention compiled to ordinary registrations on the same router.
    const fileRouted = await app.handle("GET", "/lab/gallery");
    const handWritten = await app.handle("GET", "/lab/listings/bel-air-glen");

    expect(fileRouted.status).toBe(200);
    expect(handWritten.status).toBe(200);
  });
});

describe("file-based routing — richer segments (dx-parity W6)", () => {
  it("serves a catch-all page with the trailing path as a typed string[]", async () => {
    const app = await buildApp();

    const html = await body(await app.handle("GET", "/lab/gallery/more/path/downtown/lofts"));

    expect(html).toContain('data-file-route="more-catch-all"');
    // The greedy `[...crumbs]` captured BOTH segments as a string[] the load read.
    expect(html).toContain("downtown / lofts");
    expect(html).toContain('<code data-crumb-count="true">2</code>');
  });

  it("404s a required catch-all with no trailing segment", async () => {
    const app = await buildApp();

    // `more/path/[...crumbs]` needs at least one segment — the bare parent misses.
    expect((await app.handle("GET", "/lab/gallery/more/path")).status).toBe(404);
  });

  it("serves an optional catch-all at its bare parent AND with segments", async () => {
    const app = await buildApp();

    // Zero segments → the parent path matches, facets is [].
    const bare = await body(await app.handle("GET", "/lab/gallery/more/filter"));
    expect(bare).toContain('data-file-route="more-optional-catch-all"');
    expect(bare).toContain("bare parent path");

    // Many segments → the same page, facets is the captured array.
    const many = await body(await app.handle("GET", "/lab/gallery/more/filter/luxury/waterfront"));
    expect(many).toContain("Filtering by: luxury, waterfront");
  });

  it("strips a (group) folder from the URL while still nesting its layout", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/gallery/more/about");
    expect(response.status).toBe(200);

    const html = await body(response);

    // The `(notes)` group added NO URL segment, yet its layout wraps the page —
    // inside the convention's root layout (the group nests by directory).
    expect(html).toContain('data-file-route="more-group-about"');
    expect(html).toContain('data-file-route-layout="notes-group"');
    expect(html).toContain('data-file-route-layout="root"');
  });
});
