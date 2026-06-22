import { describe, expect, test } from "vitest";

import { scanConventions } from "../src/agents/scan";
import type { ScanInput } from "../src/agents/scan";
import { CLI_COMMANDS } from "../src/agents/commands";
import type { AppSummary } from "../src/agents/types";

const summary: AppSummary = { framework: "lesto", uiDialect: "react" };

/** A fully-populated, deliberately UNSORTED input so the ordering assertions bite. */
function unsortedInput(): ScanInput {
  return {
    summary,
    routes: [
      { kind: "page", pattern: "/blog/:slug" },
      { kind: "layout", pattern: "/" },
      { kind: "page", pattern: "/" },
      { kind: "page", pattern: "/about" },
    ],
    islands: ["Counter", "Aside", "Nav"],
    collections: [
      { name: "posts", entryCount: 3 },
      { name: "authors", entryCount: 1 },
    ],
    commands: [
      { name: "build", summary: "b" },
      { name: "alpha", summary: "a" },
    ],
  };
}

describe("scanConventions", () => {
  test("sorts routes by pattern then kind", () => {
    const { routes } = scanConventions(unsortedInput());

    expect(routes.map((r) => `${r.pattern} ${r.kind}`)).toEqual([
      "/ layout", // same pattern "/" → kind breaks the tie (layout < page)
      "/ page",
      "/about page",
      "/blog/:slug page",
    ]);
  });

  test("sorts islands and collections by name", () => {
    const { islands, collections } = scanConventions(unsortedInput());

    expect(islands).toEqual(["Aside", "Counter", "Nav"]);
    expect(collections.map((c) => c.name)).toEqual(["authors", "posts"]);
  });

  test("sorts the provided commands by name", () => {
    const { commands } = scanConventions(unsortedInput());

    expect(commands.map((c) => c.name)).toEqual(["alpha", "build"]);
  });

  test("defaults the command catalogue to CLI_COMMANDS when none is given", () => {
    const { commands } = scanConventions({
      summary,
      routes: [{ kind: "page", pattern: "/" }],
      islands: [],
      collections: [],
    });

    expect(commands.map((c) => c.name)).toEqual(
      CLI_COMMANDS.map((c) => c.name).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  test("carries the app summary through unchanged", () => {
    expect(scanConventions(unsortedInput()).summary).toEqual(summary);
  });

  test("does not mutate the caller's arrays", () => {
    const input = unsortedInput();
    const routesBefore = [...input.routes];
    const islandsBefore = [...input.islands];

    scanConventions(input);

    expect(input.routes).toEqual(routesBefore);
    expect(input.islands).toEqual(islandsBefore);
  });

  test("is deterministic — two differently-ordered inputs scan equal", () => {
    const a = scanConventions(unsortedInput());

    const reordered = unsortedInput();
    const b = scanConventions({
      ...reordered,
      routes: reordered.routes.toReversed(),
      islands: reordered.islands.toReversed(),
      collections: reordered.collections.toReversed(),
    });

    expect(b).toEqual(a);
  });

  test("flags a populated app as non-empty", () => {
    expect(scanConventions(unsortedInput()).isEmpty).toBe(false);
  });

  test("flags an app with no routes, islands, or collections as empty (CLI surface excluded)", () => {
    const artifacts = scanConventions({
      summary,
      routes: [],
      islands: [],
      collections: [],
    });

    expect(artifacts.isEmpty).toBe(true);
    // The CLI surface is always present and must not count toward emptiness.
    expect(artifacts.commands.length).toBeGreaterThan(0);
  });

  test.each([
    [
      "only routes",
      { routes: [{ kind: "page" as const, pattern: "/" }], islands: [], collections: [] },
    ],
    ["only islands", { routes: [], islands: ["Counter"], collections: [] }],
    [
      "only collections",
      { routes: [], islands: [], collections: [{ name: "posts", entryCount: 0 }] },
    ],
  ])("is non-empty when it has %s", (_label, partial) => {
    expect(scanConventions({ summary, ...partial }).isEmpty).toBe(false);
  });
});
