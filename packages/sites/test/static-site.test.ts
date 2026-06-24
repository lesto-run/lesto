/**
 * `defineStaticSite` — a prerendered site's discoverability surface: the sitemap
 * derived from its routes, and a sink-driven emit of sitemap/robots/og/favicon.
 */

import { describe, expect, it } from "vitest";

import { defineStaticSite, type OutputSink } from "../src/index";

/** A sink that records every write into a map, for asserting what was emitted. */
function captureSink(): { files: Map<string, string>; sink: OutputSink } {
  const files = new Map<string, string>();
  const sink: OutputSink = (path: string, contents: Uint8Array | string): Promise<void> => {
    files.set(path, typeof contents === "string" ? contents : new TextDecoder().decode(contents));
    return Promise.resolve();
  };
  return { files, sink };
}

describe("defineStaticSite", () => {
  it("derives canonical sitemap URLs with the default priority and strips a trailing slash", () => {
    const site = defineStaticSite({
      siteUrl: "https://lesto.run/",
      routes: ["/", "/blog"],
    });

    expect(site.sitemapUrls).toEqual([
      { loc: "https://lesto.run/", priority: 1 },
      { loc: "https://lesto.run/blog", priority: 0.7 },
    ]);
  });

  it("honors a custom priority function", () => {
    const site = defineStaticSite({
      siteUrl: "https://lesto.run",
      routes: ["/", "/blog"],
      priority: (route) => (route === "/blog" ? 0.9 : 0.5),
    });

    expect(site.sitemapUrls.map((u) => u.priority)).toEqual([0.5, 0.9]);
  });

  it("emits sitemap.xml + robots.txt, plus og.svg and favicon.svg when supplied", async () => {
    const { files, sink } = captureSink();
    const site = defineStaticSite({
      siteUrl: "https://lesto.run",
      routes: ["/"],
      og: "<svg>og</svg>",
      favicon: "<svg>fav</svg>",
    });

    await site.emit(sink);

    expect([...files.keys()].toSorted()).toEqual([
      "favicon.svg",
      "og.svg",
      "robots.txt",
      "sitemap.xml",
    ]);
    expect(files.get("sitemap.xml")).toContain("https://lesto.run/");
    expect(files.get("robots.txt")).toContain("Sitemap: https://lesto.run/sitemap.xml");
    expect(files.get("og.svg")).toBe("<svg>og</svg>");
    expect(files.get("favicon.svg")).toBe("<svg>fav</svg>");
  });

  it("omits og.svg and favicon.svg when not supplied", async () => {
    const { files, sink } = captureSink();
    const site = defineStaticSite({ siteUrl: "https://lesto.run", routes: ["/"] });

    await site.emit(sink);

    expect([...files.keys()].toSorted()).toEqual(["robots.txt", "sitemap.xml"]);
  });
});
