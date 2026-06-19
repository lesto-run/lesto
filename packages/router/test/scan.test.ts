import { describe, expect, it } from "vitest";

import { type DirEntry, type DirReader, type DiscoveredFile, scanRoutes } from "../src/index";

/**
 * Build an in-memory {@link DirReader} over a literal tree, so the scan is
 * exercised with no filesystem. The tree maps a directory path to its entries; a
 * name ending in `/` is a subdirectory.
 */
function fakeReader(tree: Record<string, readonly string[]>): DirReader {
  return (path: string): Promise<readonly DirEntry[]> => {
    const names = tree[path] ?? [];

    return Promise.resolve(
      names.map((name) =>
        name.endsWith("/")
          ? { name: name.slice(0, -1), isDirectory: true }
          : { name, isDirectory: false },
      ),
    );
  };
}

/** A stable key for a discovered file, so a set comparison ignores order. */
const keyOf = (file: DiscoveredFile): string => `${file.kind}:${file.segments.join("/")}`;

const keys = (files: readonly DiscoveredFile[]): string[] => files.map(keyOf).sort();

describe("scanRoutes", () => {
  it("finds the root page", async () => {
    const reader = fakeReader({ app: ["page.tsx"] });

    expect(keys(await scanRoutes(reader, "app"))).toEqual(["page:"]);
  });

  it("finds a page and a layout at the root", async () => {
    const reader = fakeReader({ app: ["page.tsx", "layout.tsx"] });

    expect(keys(await scanRoutes(reader, "app"))).toEqual(["layout:", "page:"]);
  });

  it("descends a subdirectory and records its segment", async () => {
    const reader = fakeReader({ app: ["about/"], "app/about": ["page.tsx"] });

    expect(keys(await scanRoutes(reader, "app"))).toEqual(["page:about"]);
  });

  it("descends a [param] directory like any other", async () => {
    const reader = fakeReader({
      app: ["listings/"],
      "app/listings": ["[id]/", "page.tsx", "layout.tsx"],
      "app/listings/[id]": ["page.tsx"],
    });

    expect(keys(await scanRoutes(reader, "app"))).toEqual([
      "layout:listings",
      "page:listings",
      "page:listings/[id]",
    ]);
  });

  it("recognizes every single-extension flavor of a route file", async () => {
    const reader = fakeReader({ app: ["page.ts", "layout.jsx"] });

    expect(keys(await scanRoutes(reader, "app"))).toEqual(["layout:", "page:"]);
  });

  it("ignores a co-located helper, test, and stylesheet", async () => {
    const reader = fakeReader({
      app: ["page.tsx", "page.test.tsx", "page.module.css", "card.tsx", "helper.ts"],
    });

    // Only the real `page.tsx` counts; the `page.test.tsx`/`page.module.css` (two
    // extension segments) and the unrelated files are ignored.
    expect(keys(await scanRoutes(reader, "app"))).toEqual(["page:"]);
  });

  it("ignores a bare extension-less name", async () => {
    const reader = fakeReader({ app: ["page", "layout", "page.tsx"] });

    expect(keys(await scanRoutes(reader, "app"))).toEqual(["page:"]);
  });

  it("ignores a dotfile", async () => {
    const reader = fakeReader({ app: [".keep", "page.tsx"] });

    expect(keys(await scanRoutes(reader, "app"))).toEqual(["page:"]);
  });

  it("ignores an unrecognized base name even with one extension", async () => {
    const reader = fakeReader({ app: ["loading.tsx", "page.tsx"] });

    // `loading` is not part of this convention's subset; only page/layout count.
    expect(keys(await scanRoutes(reader, "app"))).toEqual(["page:"]);
  });

  it("returns an empty list for an empty convention dir", async () => {
    expect(await scanRoutes(fakeReader({ app: [] }), "app")).toEqual([]);
  });

  it("joins paths under a root that already ends in a slash", async () => {
    // The trailing-slash branch of joinPath: `app/` + `about` must not double the slash.
    const reader = fakeReader({ "app/": ["about/"], "app/about": ["page.tsx"] });

    expect(keys(await scanRoutes(reader, "app/"))).toEqual(["page:about"]);
  });

  it("walks a multi-level tree completely", async () => {
    const reader = fakeReader({
      app: ["page.tsx", "layout.tsx", "blog/"],
      "app/blog": ["page.tsx", "[slug]/"],
      "app/blog/[slug]": ["page.tsx"],
    });

    expect(keys(await scanRoutes(reader, "app"))).toEqual([
      "layout:",
      "page:",
      "page:blog",
      "page:blog/[slug]",
    ]);
  });
});
