/**
 * The file-based-routing demo (ADR 0023) driven through the real node app, plus a
 * proof that the demo's declared descriptors match what a REAL `scanRoutes` over
 * `app/routes/` discovers — so the convention is exercised end to end and the
 * hand-declared list can never silently drift from the on-disk tree.
 */

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanRoutes } from "@lesto/router";
import type { DirEntry } from "@lesto/router";
import type { LestoResponse } from "@lesto/web";

import { buildApp } from "../src/app";
import { GALLERY_FILES } from "../src/file-routes-demo";

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

/** A stable, order-independent key for a discovered file. */
const keyOf = (file: { kind: string; segments: readonly string[] }): string =>
  `${file.kind}:${file.segments.join("/")}`;

describe("file-based routing — scan matches the declared tree", () => {
  it("scanRoutes over app/routes/ reproduces the demo's descriptor list", async () => {
    const routesDir = fileURLToPath(new URL("../app/routes", import.meta.url));

    const scanned = await scanRoutes(nodeReader, routesDir);

    // The real on-disk scan and the demo's hand-declared GALLERY_FILES must name
    // the SAME set of routes — the layout, the gallery page, and the [id] page.
    expect(scanned.map(keyOf).sort()).toEqual(GALLERY_FILES.map(keyOf).sort());
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
