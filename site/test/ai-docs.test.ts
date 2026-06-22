/**
 * The AI-native docs surface: a `.md` twin per page, an `llms.txt` index, and a
 * full-corpus `llms-full.txt`. Built from the real docs so the assertions track
 * the actual content.
 */

import { describe, expect, it } from "vitest";

import { docMarkdown, llmsFull, llmsIndex, markdownPath } from "../src/ai-docs";
import { loadDocs } from "../src/content";

const BASE = "https://docs.lesto.run";

describe("markdownPath", () => {
  it("maps the index to index.md and a nested route to its .md twin", () => {
    expect(markdownPath("/")).toBe("index.md");
    expect(markdownPath("/quickstart")).toBe("quickstart.md");
    expect(markdownPath("/batteries/data")).toBe("batteries/data.md");
  });
});

describe("docMarkdown", () => {
  it("emits frontmatter (title + url, optional description) then the body", async () => {
    const docs = await loadDocs();
    const doc = docs.find((d) => d.route === "/quickstart");
    expect(doc).toBeDefined();
    if (doc === undefined) return;

    const md = docMarkdown(doc, `${BASE}/quickstart`);
    expect(md.startsWith("---\n")).toBe(true);
    // Free-text values are JSON-quoted so a colon in a title stays valid YAML.
    expect(md).toContain(`title: ${JSON.stringify(doc.title)}`);
    expect(md).toContain(`url: ${BASE}/quickstart`);
    expect(md).toContain(doc.text.trim());
  });
});

describe("llmsIndex", () => {
  it("has a how-to-use block and links every doc to its .md twin, grouped by section", async () => {
    const docs = await loadDocs();
    const index = llmsIndex(docs, BASE);

    expect(index).toContain("# Lesto");
    expect(index).toContain("## How to use these docs");
    expect(index).toContain(`${BASE}/llms-full.txt`);
    // Every doc appears as a link to its .md twin.
    for (const doc of docs) {
      expect(index).toContain(`(${BASE}/${markdownPath(doc.route)})`);
    }
    // Sections from the nav are present as headings.
    expect(index).toContain("## Getting started");
  });
});

describe("llmsFull", () => {
  it("concatenates every doc body with its source URL", async () => {
    const docs = await loadDocs();
    const full = llmsFull(docs, BASE);

    for (const doc of docs) {
      expect(full).toContain(`# ${doc.title}`);
    }
    expect(full).toContain(`Source: ${BASE}/quickstart`);
  });
});
