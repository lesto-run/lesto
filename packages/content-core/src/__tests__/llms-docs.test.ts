/**
 * The docs AI surface: a `.md` twin per page, an `llms.txt` index, and a
 * full-corpus `llms-full.txt`. Pure transforms — asserted byte-for-byte.
 */

import { describe, expect, it } from "vitest";

import {
  markdownTwinPath,
  renderLlmsFull,
  renderLlmsIndex,
  renderMarkdownTwin,
  type LlmsDocPage,
  type LlmsDocSection,
} from "../llms-docs";

const BASE = "https://docs.example.com";

const home: LlmsDocPage = {
  route: "/",
  title: "Home",
  description: "The landing page",
  body: "Welcome.\n",
};
const quickstart: LlmsDocPage = {
  route: "/quickstart",
  title: "Quickstart: zero to running",
  description: "Get going fast",
  body: "  Run the thing.  ",
};
const nested: LlmsDocPage = { route: "/batteries/data", title: "Data", body: "Tables and rows." };

const sections: LlmsDocSection[] = [
  { title: "Getting started", pages: [home, quickstart] },
  { title: "Batteries", pages: [nested] },
];

describe("markdownTwinPath", () => {
  it("maps the index to index.md and a nested route to its .md twin", () => {
    expect(markdownTwinPath("/")).toBe("index.md");
    expect(markdownTwinPath("/quickstart")).toBe("quickstart.md");
    expect(markdownTwinPath("/batteries/data")).toBe("batteries/data.md");
  });
});

describe("renderMarkdownTwin", () => {
  it("emits frontmatter then the trimmed body, with a blank line between", () => {
    const md = renderMarkdownTwin(quickstart, `${BASE}/quickstart`);
    expect(md).toBe(
      `---\ntitle: ${JSON.stringify("Quickstart: zero to running")}\nurl: ${BASE}/quickstart\ndescription: ${JSON.stringify(
        "Get going fast",
      )}\n---\n\nRun the thing.\n`,
    );
  });

  it("omits the description line when the page has none", () => {
    const md = renderMarkdownTwin(nested, `${BASE}/batteries/data`);
    expect(md).toBe(
      `---\ntitle: ${JSON.stringify("Data")}\nurl: ${BASE}/batteries/data\n---\n\nTables and rows.\n`,
    );
    expect(md).not.toContain("description:");
  });

  it("JSON-quotes free text so a colon in the title stays valid YAML", () => {
    const md = renderMarkdownTwin(quickstart, `${BASE}/quickstart`);
    expect(md).toContain('title: "Quickstart: zero to running"');
  });
});

describe("renderLlmsIndex", () => {
  it("renders the H1, tagline, how-to-use block, and every page grouped by section", () => {
    const index = renderLlmsIndex(sections, {
      name: "Example",
      tagline: "Example is a thing.",
      siteUrl: BASE,
      howToUse: ["First bullet.", "Second bullet."],
    });

    expect(index).toBe(
      [
        "# Example",
        "",
        "> Example is a thing.",
        "",
        "## How to use these docs",
        "",
        "- First bullet.",
        "- Second bullet.",
        "",
        "## Getting started",
        "",
        `- [Home](${BASE}/index.md): The landing page`,
        `- [Quickstart: zero to running](${BASE}/quickstart.md): Get going fast`,
        "",
        "## Batteries",
        "",
        `- [Data](${BASE}/batteries/data.md)`,
        "",
      ].join("\n"),
    );
  });

  it("falls back to a derived tagline and default how-to-use bullets, and strips a trailing slash", () => {
    const index = renderLlmsIndex([{ title: "Docs", pages: [home] }], {
      name: "Example",
      siteUrl: `${BASE}/`,
    });

    expect(index).toContain("> Example documentation, published in Markdown for AI assistants.");
    expect(index).toContain(
      `- Every page is available as clean Markdown at its path + \`.md\` (the home page is \`${BASE}/index.md\`).`,
    );
    expect(index).toContain(`- \`${BASE}/llms-full.txt\` is the entire corpus in a single file.`);
    // Trailing slash on siteUrl did not double up.
    expect(index).not.toContain(`${BASE}//`);
  });
});

describe("renderLlmsFull", () => {
  it("concatenates every page body with its source URL, root as a trailing slash", () => {
    const full = renderLlmsFull(sections, { name: "Example", siteUrl: BASE });

    expect(full).toBe(
      `# Example documentation\n` +
        `\n\n---\n\n# Home\n\nSource: ${BASE}/\n\nWelcome.` +
        `\n\n---\n\n# Quickstart: zero to running\n\nSource: ${BASE}/quickstart\n\nRun the thing.` +
        `\n\n---\n\n# Data\n\nSource: ${BASE}/batteries/data\n\nTables and rows.\n`,
    );
  });
});
