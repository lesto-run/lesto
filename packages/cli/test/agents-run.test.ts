import { describe, expect, test } from "vitest";

import { createCollectionsReader, runGenerateAgents } from "../src/agents/run";
import type { GenerateAgentsDeps } from "../src/agents/run";
import { MANAGED_REGION_START } from "../src/agents/managed-region";

/** An in-memory fake of the injected seams: a file map, captured output, write log. */
function harness(overrides: Partial<GenerateAgentsDeps> = {}) {
  const files = new Map<string, string>();
  const lines: string[] = [];
  const writes: string[] = [];

  const deps: GenerateAgentsDeps = {
    readRoutes: async () => [{ kind: "page", pattern: "/" }],
    readIslands: async () => ["Counter"],
    readCollections: async () => [{ name: "posts", entryCount: 2 }],
    summary: { framework: "lesto", uiDialect: "react" },
    exists: async (path) => files.has(path),
    // Model the real fs: reading an absent path THROWS (ENOENT), so the orchestrator's
    // `existed ? read : ""` guard is load-bearing — dropping it would crash, not "".
    read: async (path) => {
      const contents = files.get(path);

      if (contents === undefined) throw new Error(`ENOENT: ${path}`);

      return contents;
    },
    write: async (path, contents) => {
      files.set(path, contents);
      writes.push(path);
    },
    out: (line) => lines.push(line),
    ...overrides,
  };

  return { deps, files, lines, writes };
}

describe("runGenerateAgents", () => {
  test("writes both artifacts on a fresh app, with the island inventory in each", async () => {
    const { deps, files, lines } = harness();

    const code = await runGenerateAgents([], deps);

    expect(code).toBe(0);
    expect(lines).toEqual(["wrote AGENTS.md", "wrote llms.txt"]);
    expect(files.get("AGENTS.md")).toContain(MANAGED_REGION_START);
    // Each artifact carries its OWN distinguishing header, so a wrong-renderer
    // regression (writing the same content to both) would fail here.
    expect(files.get("AGENTS.md")).toContain("# Agent guide");
    expect(files.get("llms.txt")).toContain("# Lesto app");
    // The island inventory appears in BOTH artifacts.
    expect(files.get("AGENTS.md")).toContain("Counter");
    expect(files.get("llms.txt")).toContain("Counter");
  });

  test("preserves author prose outside the managed region and reports an update", async () => {
    const { deps, files, lines } = harness();
    files.set("AGENTS.md", "# My own notes\n\nkeep me\n");

    await runGenerateAgents([], deps);

    const written = files.get("AGENTS.md") ?? "";
    expect(written.startsWith("# My own notes\n\nkeep me")).toBe(true);
    expect(written).toContain(MANAGED_REGION_START);
    expect(lines).toContain("updated AGENTS.md");
  });

  test("leaves byte-identical files untouched on a re-run", async () => {
    const { deps, writes, lines } = harness();

    await runGenerateAgents([], deps); // first run writes both
    writes.length = 0;
    lines.length = 0;

    const code = await runGenerateAgents([], deps); // second run: no changes

    expect(code).toBe(0);
    expect(writes).toEqual([]); // nothing rewritten
    expect(lines).toEqual(["unchanged AGENTS.md", "unchanged llms.txt"]);
  });

  test("rewrites a stale llms.txt", async () => {
    const { deps, files, lines } = harness();
    files.set("llms.txt", "stale\n");

    await runGenerateAgents([], deps);

    expect(lines).toContain("updated llms.txt");
    expect(files.get("llms.txt")).not.toBe("stale\n");
  });

  test("--check exits 0 and writes nothing when the artifacts are fresh", async () => {
    const { deps, writes, lines } = harness();
    await runGenerateAgents([], deps); // make them fresh
    writes.length = 0;
    lines.length = 0;

    const code = await runGenerateAgents(["--check"], deps);

    expect(code).toBe(0);
    expect(writes).toEqual([]);
    expect(lines).toEqual(["agent files are up to date"]);
  });

  test("--check exits 1, reports drift, and writes nothing when stale", async () => {
    const { deps, files, writes, lines } = harness();

    const code = await runGenerateAgents(["--check"], deps);

    expect(code).toBe(1);
    expect(lines).toEqual(["drift AGENTS.md", "drift llms.txt"]);
    expect(writes).toEqual([]);
    expect(files.size).toBe(0); // truly nothing written
  });

  test("--dry-run announces a fresh plan and writes nothing", async () => {
    const { deps, files, lines } = harness();

    const code = await runGenerateAgents(["--dry-run"], deps);

    expect(code).toBe(0);
    expect(lines).toEqual(["would write AGENTS.md", "would write llms.txt"]);
    expect(files.size).toBe(0);
  });

  test("--dry-run says 'update' for files that already exist", async () => {
    const { deps, files, lines } = harness();
    files.set("AGENTS.md", "x");
    files.set("llms.txt", "y");

    await runGenerateAgents(["--dry-run"], deps);

    expect(lines).toEqual(["would update AGENTS.md", "would update llms.txt"]);
  });

  test("--dry-run reports 'would leave … unchanged' for already-fresh files", async () => {
    const { deps, lines } = harness();
    await runGenerateAgents([], deps); // make both current
    lines.length = 0;

    const code = await runGenerateAgents(["--dry-run"], deps);

    expect(code).toBe(0);
    expect(lines).toEqual(["would leave AGENTS.md unchanged", "would leave llms.txt unchanged"]);
  });

  test("--check wins when both --check and --dry-run are passed", async () => {
    const { deps, writes } = harness();

    const code = await runGenerateAgents(["--check", "--dry-run"], deps);

    expect(code).toBe(1); // check semantics (drift), not dry-run's 0
    expect(writes).toEqual([]);
  });

  test("refuses an app with nothing to describe (coded CLI_AGENTS_NOTHING_TO_SCAN)", async () => {
    const { deps } = harness({
      readRoutes: async () => [],
      readIslands: async () => [],
      readCollections: async () => [],
    });

    await expect(runGenerateAgents([], deps)).rejects.toMatchObject({
      code: "CLI_AGENTS_NOTHING_TO_SCAN",
    });
  });
});

describe("createCollectionsReader", () => {
  test("groups pipeline entries by collection into name + entry count", async () => {
    const read = createCollectionsReader(async () => ({
      entries: [{ collection: "docs" }, { collection: "docs" }, { collection: "blog" }],
    }));

    // First-seen order (the scan re-sorts by name); `docs` counts both its entries.
    expect(await read()).toEqual([
      { name: "docs", entryCount: 2 },
      { name: "blog", entryCount: 1 },
    ]);
  });

  test("an empty run yields no collections", async () => {
    const read = createCollectionsReader(async () => ({ entries: [] }));

    expect(await read()).toEqual([]);
  });

  test("a pipeline failure degrades to no collections and is surfaced via onError", async () => {
    const warned: unknown[] = [];
    const read = createCollectionsReader(
      async () => {
        throw new Error("bad frontmatter");
      },
      (cause) => warned.push(cause),
    );

    expect(await read()).toEqual([]);
    expect(warned).toHaveLength(1);
    expect((warned[0] as Error).message).toBe("bad frontmatter");
  });

  test("a pipeline failure still degrades when no onError sink is given", async () => {
    const read = createCollectionsReader(async () => {
      throw new Error("bad frontmatter");
    });

    expect(await read()).toEqual([]);
  });
});
