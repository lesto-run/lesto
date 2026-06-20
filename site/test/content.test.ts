/**
 * The content pipeline produces the docs the site routes on.
 *
 * Proves the seam between `@lesto/content-*` and the app: every Markdown file
 * under `content/docs/` loads, validates, renders to HTML, and lands at a unique
 * route — and that the nav groups those docs into the expected, ordered sections.
 */

import { describe, expect, it } from "vitest";

import { buildNav, loadDocs } from "../src/content";

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
      "Quickstart",
      "Concepts",
    ]);
  });
});
