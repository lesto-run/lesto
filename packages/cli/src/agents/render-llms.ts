/**
 * Render the project `llms.txt` — a flat, machine-readable index of this Lesto
 * app's conventions, from the same {@link AgentArtifacts} the `AGENTS.md` renderer
 * uses (so the two can never disagree).
 *
 * This is the PROJECT/convention index (routes + islands + collections + the CLI
 * surface), written to `site/llms.txt` in Inc 6. It is deliberately distinct from
 * the DOCS index — the list of content pages an agent can fetch — which is rendered
 * by `@lesto/content-core`'s `generateLlmsTxt` over content entries and written to
 * a different path (`site/public/llms-docs.txt`, Inc 8). Different input (scanned
 * conventions vs content entries), different path, different renderer; this one
 * does not reimplement that one.
 *
 * Shape follows the llmstxt.org convention — an H1, a one-line blockquote summary,
 * then `##` sections of bullets. Pure and byte-stable: same artifacts in, identical
 * text out (the scan already sorted everything by code point). No `fs`, no `process`.
 */

import type { AgentArtifacts } from "./types";

/** One `## heading` section over its bullet lines. */
function renderSection(heading: string, items: readonly string[]): string {
  return `## ${heading}\n${items.join("\n")}`;
}

/**
 * Render the project `llms.txt`. Sections for routes, islands, and collections
 * appear only when they have entries (a flat index lists what exists); the CLI
 * surface is always present, so its section is always rendered. Ends with a single
 * trailing newline.
 */
export function renderLlmsTxt(artifacts: AgentArtifacts): string {
  const sections: string[] = [];

  if (artifacts.routes.length > 0) {
    sections.push(
      renderSection(
        "Routes",
        artifacts.routes.map((route) => `- \`${route.pattern}\` (${route.kind})`),
      ),
    );
  }

  if (artifacts.islands.length > 0) {
    sections.push(
      renderSection(
        "Islands",
        artifacts.islands.map((name) => `- \`${name}\``),
      ),
    );
  }

  if (artifacts.collections.length > 0) {
    sections.push(
      renderSection(
        "Content collections",
        artifacts.collections.map((collection) => {
          const noun = collection.entryCount === 1 ? "entry" : "entries";

          return `- \`${collection.name}\` (${collection.entryCount} ${noun})`;
        }),
      ),
    );
  }

  // The CLI surface is always present, so this section always renders.
  sections.push(
    renderSection(
      "CLI commands",
      artifacts.commands.map((command) => {
        const aliases =
          command.aliases !== undefined && command.aliases.length > 0
            ? ` (alias ${command.aliases.map((a) => `\`${a}\``).join(", ")})`
            : "";

        return `- \`lesto ${command.name}\`${aliases}: ${command.summary}`;
      }),
    ),
  );

  const header = [
    "# Lesto app",
    "",
    "> Machine-readable index of this Lesto app's routes, islands, content collections, and CLI commands.",
  ].join("\n");

  return `${header}\n\n${sections.join("\n\n")}\n`;
}
