/**
 * The content pipeline produces the docs the site routes on.
 *
 * Proves the seam between `@lesto/content-*` and the app: every Markdown file
 * under `content/docs/` loads, validates, renders to HTML, and lands at a unique
 * route — and that the nav groups those docs into the expected, ordered sections.
 */

import { describe, expect, it } from "vitest";

import { adjacentDocs, buildNav, loadDocs } from "../src/content";

describe("loadDocs", () => {
  it("loads every doc with a unique route and rendered HTML", async () => {
    const docs = await loadDocs();
    const routes = docs.map((doc) => doc.route);

    // Every doc must have a unique route and render to non-empty HTML.
    expect(docs.length).toBeGreaterThanOrEqual(18);
    expect(new Set(routes).size).toBe(routes.length);
    for (const doc of docs) {
      expect(doc.title).not.toBe("");
      expect(doc.section).not.toBe("");
      expect(doc.html.length).toBeGreaterThan(0);
    }
  });

  it("maps the index file to `/` and nested files to their path", async () => {
    const routes = new Set((await loadDocs()).map((doc) => doc.route));

    expect(routes.has("/")).toBe(true);
    expect(routes.has("/quickstart")).toBe(true);
    expect(routes.has("/guides/routing")).toBe(true);
    expect(routes.has("/batteries/data")).toBe(true);
    expect(routes.has("/batteries/admin")).toBe(true);
    expect(routes.has("/deploy/cloudflare")).toBe(true);
    expect(routes.has("/reference/cli")).toBe(true);
  });

  it("renders fenced code with syntax-highlighting markup", async () => {
    const quickstart = (await loadDocs()).find((doc) => doc.route === "/quickstart");

    // Shiki (via rehype-pretty-code) wraps each block and colors tokens inline.
    expect(quickstart?.html).toContain("data-rehype-pretty-code-figure");
    expect(quickstart?.html).toMatch(/style="color:#[0-9A-Fa-f]{6}"/);
  });

  it("extracts a heading outline for the on-page table of contents", async () => {
    const data = (await loadDocs()).find((doc) => doc.route === "/batteries/data");

    // The "## Query" heading becomes a depth-2 entry the TOC can link to.
    expect(data?.headings.some((h) => h.depth === 2 && h.slug === "query")).toBe(true);
  });
});

describe("buildNav", () => {
  it("groups docs into ordered sections", async () => {
    const nav = buildNav(await loadDocs());

    expect(nav.map((section) => section.title)).toEqual([
      "Getting started",
      "Guides",
      "Migrate",
      "Batteries",
      "Deploy",
      "Reference",
    ]);
  });

  it("orders pages within a section by their `order`", async () => {
    const nav = buildNav(await loadDocs());
    const gettingStarted = nav.find((section) => section.title === "Getting started");

    expect(gettingStarted?.items.map((item) => item.title)).toEqual([
      "Introduction",
      "Why Lesto",
      "Quickstart",
      "Concepts",
    ]);
  });

  it("uses a page's `navLabel` for its sidebar label, falling back to the title", async () => {
    const items = buildNav(await loadDocs()).flatMap((section) => section.items);

    // The authenticated-MCP guide keeps its descriptive title but shows a short nav label.
    const authMcp = items.find((item) => item.route === "/guides/authenticated-mcp");
    expect(authMcp?.title).toBe("Build an authenticated MCP server");
    expect(authMcp?.label).toBe("Authenticated MCP");

    // A page with no `navLabel` labels the sidebar with its title verbatim.
    const data = items.find((item) => item.route === "/batteries/data");
    expect(data?.label).toBe(data?.title);

    // No sidebar label is long enough to wrap the rail — titles that are really
    // one-line descriptions (the SEO page's old 66-char title) must not creep back.
    for (const item of items) {
      expect(item.label.length, `${item.route} nav label too long`).toBeLessThanOrEqual(28);
    }
  });
});

describe("adjacentDocs", () => {
  it("returns the prev/next pages in nav reading order across sections", async () => {
    const nav = buildNav(await loadDocs());
    const sequence = nav.flatMap((section) => section.items);
    expect(sequence.length).toBeGreaterThan(2);

    // The first page has no prev; the last has no next.
    const first = sequence[0]!;
    const last = sequence[sequence.length - 1]!;
    expect(adjacentDocs(nav, first.route).prev).toBeUndefined();
    expect(adjacentDocs(nav, last.route).next).toBeUndefined();

    // An interior page links both ways, to its sidebar neighbors.
    const second = sequence[1]!;
    const { prev, next } = adjacentDocs(nav, second.route);
    expect(prev?.route).toBe(first.route);
    expect(next?.route).toBe(sequence[2]!.route);
  });

  it("returns undefined both ways for an unknown route", async () => {
    const nav = buildNav(await loadDocs());
    expect(adjacentDocs(nav, "/nope")).toEqual({ prev: undefined, next: undefined });
  });
});
