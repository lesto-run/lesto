/**
 * The AI-native docs surface — `llms.txt`, `llms-full.txt`, and a clean Markdown
 * twin of every page.
 *
 * Lesto is an agent-native framework, so its docs are built to be read by agents,
 * not just people: append `.md` to any docs URL for that page's raw Markdown,
 * fetch `/llms.txt` for an indexed map of the whole site (with instructions), or
 * `/llms-full.txt` for the entire corpus in one file. `build.ts` writes these
 * alongside the prerendered HTML; the edge serves them as static assets.
 *
 * These are pure functions of the loaded docs so they are tested directly.
 */

import { buildNav, type DocEntry } from "./content";

/** The `.md` path for a route: `/` → `index.md`, `/a/b` → `a/b.md`. */
export function markdownPath(route: string): string {
  return route === "/" ? "index.md" : `${route.slice(1)}.md`;
}

/** One page as a clean Markdown document: a small frontmatter block + its body. */
export function docMarkdown(doc: DocEntry, url: string): string {
  // JSON-stringify the free-text values: a title/description containing a colon
  // or other YAML metacharacter must still parse as a valid scalar for an agent.
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(doc.title)}`,
    `url: ${url}`,
    ...(doc.description === undefined ? [] : [`description: ${JSON.stringify(doc.description)}`]),
    "---",
    "",
  ].join("\n");
  return `${frontmatter}\n${doc.text.trim()}\n`;
}

/** Order the docs the way the nav does: by section, then by in-section order. */
function inNavOrder(docs: readonly DocEntry[]): DocEntry[] {
  const byRoute = new Map(docs.map((doc) => [doc.route, doc]));
  return buildNav(docs)
    .flatMap((section) => section.items.map((item) => byRoute.get(item.route)))
    .filter((doc): doc is DocEntry => doc !== undefined);
}

/**
 * `llms.txt` — the agent-facing index: a short intro, a "how to use these docs"
 * block (the Stripe convention of telling the agent how to consume the site),
 * then every page grouped by section as a link to its `.md` twin.
 */
export function llmsIndex(docs: readonly DocEntry[], baseUrl: string): string {
  const byRoute = new Map(docs.map((doc) => [doc.route, doc]));
  const lines: string[] = [
    "# Lesto",
    "",
    "> Lesto is a batteries-included, agent-native, full-stack TypeScript framework. This documentation is published in Markdown for AI assistants to read directly.",
    "",
    "## How to use these docs",
    "",
    `- Every page is available as clean Markdown at its path + \`.md\` (e.g. \`${baseUrl}/quickstart.md\`; the home page is \`${baseUrl}/index.md\`).`,
    `- \`${baseUrl}/llms-full.txt\` is the entire docs corpus in a single file.`,
    "- Pages tag anything that is preview or deferred; if a page does not say so, treat it as shipped.",
    "",
  ];

  for (const section of buildNav(docs)) {
    lines.push(`## ${section.title}`, "");
    for (const item of section.items) {
      const description = byRoute.get(item.route)?.description;
      const suffix = description === undefined ? "" : `: ${description}`;
      lines.push(`- [${item.title}](${baseUrl}/${markdownPath(item.route)})${suffix}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** `llms-full.txt` — the whole corpus concatenated, each page with its source URL. */
export function llmsFull(docs: readonly DocEntry[], baseUrl: string): string {
  const parts = ["# Lesto documentation", ""];
  for (const doc of inNavOrder(docs)) {
    const url = doc.route === "/" ? `${baseUrl}/` : `${baseUrl}${doc.route}`;
    parts.push(`\n---\n\n# ${doc.title}\n\nSource: ${url}\n\n${doc.text.trim()}`);
  }
  return `${parts.join("\n")}\n`;
}
