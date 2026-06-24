/**
 * The AI-native docs surface — `.md` page twins, an `llms.txt` index, and a
 * full-corpus `llms-full.txt`, built from a documentation site's pages.
 *
 * A docs site is built to be read by agents, not just people: append `.md` to any
 * page URL for that page's raw Markdown, fetch `/llms.txt` for an indexed map of
 * the whole site (with usage instructions, the llmstxt.org convention), or
 * `/llms-full.txt` for the entire corpus in one file. A build step writes these
 * alongside the prerendered HTML; the edge serves them as static assets.
 *
 * This is the DOCS surface — an index of content *pages* an agent can fetch. It is
 * deliberately distinct from {@link generateLlmsTxt} (a feed/collection index over
 * content entries) and from the CLI's project/convention `llms.txt` (routes +
 * islands + collections + the CLI surface). Different input, different consumer.
 *
 * Every function here is a pure transform of its inputs — same pages in, identical
 * bytes out — so a consuming site can unit-test the wiring and trust the artifacts.
 * No `fs`, no `process`.
 */

/** A single documentation page: its served route, metadata, and raw Markdown body. */
export interface LlmsDocPage {
  /** The route the page is served at: `/` or `/guides/x`. Drives the `.md` twin path and corpus URL. */
  readonly route: string;
  readonly title: string;
  /** A one-line summary, shown after the index link. Omit when the page has none. */
  readonly description?: string | undefined;
  /** The page's raw Markdown body (the source text, not rendered HTML). */
  readonly body: string;
}

/** A navigation group: a section title and its pages, already in display order. */
export interface LlmsDocSection {
  readonly title: string;
  readonly pages: readonly LlmsDocPage[];
}

/** Shared metadata for the `llms.txt` index and the `llms-full.txt` corpus. */
export interface LlmsDocsOptions {
  /** Project name — the H1 of `llms.txt` (`# {name}`) and the corpus (`# {name} documentation`). */
  readonly name: string;
  /** One-line blockquote summary under the index H1. Defaults to a generic line derived from {@link name}. */
  readonly tagline?: string;
  /** Absolute site origin, e.g. `https://docs.example.com`. A trailing slash is ignored. */
  readonly siteUrl: string;
  /**
   * The bullets of the "How to use these docs" block (each rendered as `- {text}`).
   * Defaults to two generic bullets pointing at the `.md` twins and `llms-full.txt`.
   */
  readonly howToUse?: readonly string[];
}

/** Drop a single trailing slash so `${siteUrl}${route}` never doubles up. */
function origin(siteUrl: string): string {
  return siteUrl.replace(/\/$/, "");
}

/** The `.md` twin path for a route: `/` → `index.md`, `/a/b` → `a/b.md`. */
export function markdownTwinPath(route: string): string {
  return route === "/" ? "index.md" : `${route.slice(1)}.md`;
}

/** The default "How to use these docs" bullets when {@link LlmsDocsOptions.howToUse} is omitted. */
function defaultHowToUse(siteUrl: string): string[] {
  return [
    `Every page is available as clean Markdown at its path + \`.md\` (the home page is \`${siteUrl}/index.md\`).`,
    `\`${siteUrl}/llms-full.txt\` is the entire corpus in a single file.`,
  ];
}

/**
 * One page as a clean Markdown document: a small frontmatter block then its body.
 *
 * Free-text values (title, description) are JSON-stringified so a colon or other
 * YAML metacharacter in the text still parses as a valid scalar for an agent.
 */
export function renderMarkdownTwin(page: LlmsDocPage, url: string): string {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `url: ${url}`,
    ...(page.description === undefined ? [] : [`description: ${JSON.stringify(page.description)}`]),
    "---",
    "",
  ].join("\n");
  return `${frontmatter}\n${page.body.trim()}\n`;
}

/**
 * `llms.txt` — the agent-facing index: an H1, a one-line blockquote, a "How to use
 * these docs" block, then every page grouped by section as a link to its `.md` twin.
 */
export function renderLlmsIndex(
  sections: readonly LlmsDocSection[],
  options: LlmsDocsOptions,
): string {
  const baseUrl = origin(options.siteUrl);
  const tagline =
    options.tagline ?? `${options.name} documentation, published in Markdown for AI assistants.`;
  const howToUse = options.howToUse ?? defaultHowToUse(baseUrl);

  const lines: string[] = [
    `# ${options.name}`,
    "",
    `> ${tagline}`,
    "",
    "## How to use these docs",
    "",
    ...howToUse.map((bullet) => `- ${bullet}`),
    "",
  ];

  for (const section of sections) {
    lines.push(`## ${section.title}`, "");
    for (const page of section.pages) {
      const suffix = page.description === undefined ? "" : `: ${page.description}`;
      lines.push(`- [${page.title}](${baseUrl}/${markdownTwinPath(page.route)})${suffix}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** `llms-full.txt` — the whole corpus concatenated, each page with its source URL. */
export function renderLlmsFull(
  sections: readonly LlmsDocSection[],
  options: LlmsDocsOptions,
): string {
  const baseUrl = origin(options.siteUrl);
  const parts = [`# ${options.name} documentation`, ""];
  for (const section of sections) {
    for (const page of section.pages) {
      const url = page.route === "/" ? `${baseUrl}/` : `${baseUrl}${page.route}`;
      parts.push(`\n---\n\n# ${page.title}\n\nSource: ${url}\n\n${page.body.trim()}`);
    }
  }
  return `${parts.join("\n")}\n`;
}
