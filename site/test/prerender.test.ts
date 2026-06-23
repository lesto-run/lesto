/**
 * The static build prerenders every doc to a file.
 *
 * Runs the same `buildStaticSites` path `build.ts` uses, but writes through an
 * in-memory sink so the test can assert what would land on disk: one HTML file
 * per route, every page 2xx (a non-2xx page would make the all-or-nothing build
 * throw before writing), at the clean-URL path Cloudflare serves.
 */

import { createApp } from "@lesto/kernel";
import { buildStaticSites } from "@lesto/sites";
import type { OutputSink } from "@lesto/sites";
import { describe, expect, it } from "vitest";

import appConfig from "../lesto.app";
import sites from "../lesto.sites";
import { loadDocs } from "../src/content";

describe("buildStaticSites", () => {
  it("writes one 2xx HTML file per doc at its clean-URL path", async () => {
    const app = await createApp(appConfig);
    const written = new Map<string, string>();
    const sink: OutputSink = async (path: string, contents: string | Uint8Array) => {
      written.set(path, typeof contents === "string" ? contents : new TextDecoder().decode(contents));
    };

    const manifests = await buildStaticSites(sites, app.handle, sink);
    const docs = await loadDocs();

    const pages = manifests.flatMap((manifest) => manifest.pages);
    // One page per doc route (the blog + changelog moved to the marketing site).
    expect(pages.length).toBe(docs.length);
    expect(pages.every((page) => page.status >= 200 && page.status < 300)).toBe(true);

    // The index lands at docs/index.html; a nested route at its directory index.
    expect(written.has("docs/index.html")).toBe(true);
    expect(written.get("docs/batteries/data/index.html")).toContain("Data · Lesto");
  });
});
