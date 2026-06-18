#!/usr/bin/env bun
/**
 * Bundle-size assertion — the regression guard for blocker #8 (the ~10 KB
 * Preact-by-default island bundle, ADR 0007/0011).
 *
 * It builds the framework's island client TWICE through the real
 * `@volo/assets` pipeline (`buildClient` + the Bun bundler deps) — once for the
 * `react` dialect, once for `preact` — against a minimal self-contained island
 * fixture, minified exactly as a production build, and measures the gzipped
 * `client.js`. Then it asserts the two budgets the roadmap fixes in CI:
 *
 *   - the `react` client entry  ≤ 65 KB gzip
 *   - the `preact` client entry ≤ 15 KB gzip
 *
 * Why a standalone Bun script and not a vitest case: `Bun.build` (the only API
 * that can apply the preact resolver plugin) is a Bun global undefined under
 * vitest — the same reason `bun.ts` is the coverage-gate's excluded edge. CI
 * runs this as its own job (`bun run bundle-size`, see the root script); it is
 * runnable locally with the same command. A regression makes it exit non-zero,
 * so the 118 KB react-dom-server-dragging bundle can never silently return.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { buildClient, bunBuildClientDeps } from "../src/index";
import type { Dialect } from "../src/index";

/** The gzip budget, in bytes, per dialect — the roadmap's Wave 2 "Done" bar. */
const BUDGET_GZIP_BYTES: Record<Dialect, number> = {
  react: 65 * 1024,
  preact: 15 * 1024,
};

/** Where the fixture island the bundle is measured against lives. */
const FIXTURE_ISLANDS = join(import.meta.dir, "fixture-islands");

/** The repo root, where `@volo/ui`, `react`, and `preact` all resolve from. */
const APP_ROOT = join(import.meta.dir, "..", "..", "..");

/** Build one dialect's production client and return its gzipped entry size in bytes. */
async function measure(dialect: Dialect): Promise<number> {
  const outDir = await mkdtemp(join(tmpdir(), `volo-bundle-${dialect}-`));

  try {
    const { entry } = await buildClient(
      { islandsDir: FIXTURE_ISLANDS, outDir, mode: "production", dialect },
      bunBuildClientDeps(APP_ROOT),
    );

    const bytes = await readFile(entry);

    return gzipSync(bytes).byteLength;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** Human-readable KB to one decimal place. */
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const failures: string[] = [];

for (const dialect of ["react", "preact"] as const) {
  const size = await measure(dialect);
  const budget = BUDGET_GZIP_BYTES[dialect];
  const ok = size <= budget;

  console.log(`${ok ? "✓" : "✗"} ${dialect}: ${kb(size)} gzip (budget ${kb(budget)})`);

  if (!ok) {
    failures.push(`${dialect} client entry is ${kb(size)} gzip, over the ${kb(budget)} budget`);
  }
}

if (failures.length > 0) {
  console.error(`\nBundle-size assertion failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log("\nBundle-size assertion passed.");
