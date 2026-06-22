import { describe, expect, test } from "vitest";

import { renderLlmsTxt } from "../src/agents/render-llms";
import { scanConventions } from "../src/agents/scan";

describe("renderLlmsTxt", () => {
  test("renders a full index deterministically (byte-stable snapshot)", () => {
    const artifacts = scanConventions({
      summary: { framework: "lesto", uiDialect: "react" },
      routes: [
        { kind: "page", pattern: "/blog/:slug" },
        { kind: "page", pattern: "/" },
      ],
      islands: ["Counter"],
      collections: [
        { name: "posts", entryCount: 3 },
        { name: "tags", entryCount: 1 },
      ],
      commands: [
        { name: "generate", aliases: ["g"], summary: "Scaffold a resource" },
        { name: "serve", summary: "Boot the app over HTTP" },
      ],
    });

    expect(renderLlmsTxt(artifacts)).toBe(
      `${[
        "# Lesto app",
        "",
        "> Machine-readable index of this Lesto app's routes, islands, content collections, and CLI commands.",
        "",
        "## Routes",
        "- `/` (page)",
        "- `/blog/:slug` (page)",
        "",
        "## Islands",
        "- `Counter`",
        "",
        "## Content collections",
        "- `posts` (3 entries)",
        "- `tags` (1 entry)", // singular noun at count 1
        "",
        "## CLI commands",
        "- `lesto generate` (alias `g`): Scaffold a resource",
        "- `lesto serve`: Boot the app over HTTP",
      ].join("\n")}\n`,
    );
  });

  test("omits empty route/island/collection sections (the CLI section always renders)", () => {
    const out = renderLlmsTxt(
      scanConventions({
        summary: { framework: "lesto" },
        routes: [],
        islands: [],
        collections: [],
        commands: [{ name: "help", summary: "Show help" }],
      }),
    );

    expect(out).not.toContain("## Routes");
    expect(out).not.toContain("## Islands");
    expect(out).not.toContain("## Content collections");
    expect(out).toContain("## CLI commands");
    expect(out).toContain("- `lesto help`: Show help");
  });

  test("ends with exactly one trailing newline", () => {
    const out = renderLlmsTxt(
      scanConventions({
        summary: { framework: "lesto" },
        routes: [{ kind: "page", pattern: "/" }],
        islands: [],
        collections: [],
        commands: [{ name: "serve", summary: "Boot" }],
      }),
    );

    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});
