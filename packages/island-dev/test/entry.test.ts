/**
 * The dev entry is the shipped `synthesizeEntry` output with the dev beacon flag —
 * so the tests confirm it carries the island registrations, the hydrate call, and
 * `dev: true` (the overlay-not-POST switch), for both eager and lazy islands.
 */

import type { IslandFile } from "@lesto/assets";
import { describe, expect, it } from "vitest";

import { devEntrySource } from "../src/entry";

const eager: IslandFile = {
  name: "Counter",
  importPath: "/abs/app/islands/counter.tsx",
  lazy: false,
  ssr: false,
};

const lazy: IslandFile = {
  name: "Chart",
  importPath: "/abs/app/islands/chart.tsx",
  lazy: true,
  ssr: false,
};

describe("devEntrySource", () => {
  it("registers an eager island by static import and wires the dev beacon", () => {
    const source = devEntrySource([eager]);

    expect(source).toContain('import Island0 from "/abs/app/islands/counter.tsx"');
    expect(source).toContain(".defineClient(Island0.island)");
    expect(source).toContain("hydrateDocumentIslands");
    expect(source).toContain("dev: true");
  });

  it("registers a lazy island by dynamic import", () => {
    const source = devEntrySource([lazy]);

    expect(source).toContain('name: "Chart"');
    expect(source).toContain('import("/abs/app/islands/chart.tsx")');
    expect(source).toContain("dev: true");
  });

  it("handles an app with no islands", () => {
    const source = devEntrySource([]);

    expect(source).toContain("hydrateDocumentIslands");
    expect(source).toContain("dev: true");
  });
});
