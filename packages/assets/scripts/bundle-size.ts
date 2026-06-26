#!/usr/bin/env bun
/**
 * Bundle-size assertion — the regression guard for blocker #8 (the ~10 KB
 * Preact-by-default island bundle, ADR 0007/0011).
 *
 * It builds the framework's island client through the real `@lesto/assets`
 * pipeline (`buildClient`) against a minimal self-contained island fixture,
 * minified exactly as a production build, and measures the gzipped `client.js` —
 * across BOTH bundler backends × BOTH dialects, asserting the same budgets:
 *
 *   - the `react` client entry  ≤ 65 KB gzip
 *   - the `preact` client entry ≤ 15 KB gzip
 *
 * Both backends are measured because both ship: `vite` (`viteBuildClientDeps`) is
 * what `lesto build` PRODUCES (DX-parity R2 Phase 2), and `Bun.build`
 * (`bunBuildClientDeps`) is the dev FALLBACK an app gets when it opts out of the
 * `@lesto/island-dev` Vite dev server. Guarding both means neither path can
 * silently regress (e.g. a barrel re-export dragging `react-dom` back into the
 * preact bundle — the leak `@lesto/ui`'s `sideEffects: false` closed).
 *
 * Why a standalone Bun script and not a vitest case: the Bun leg's `Bun.build` is
 * a Bun global undefined under vitest — the same reason `bun.ts`/`vite-build.ts`
 * are the coverage gate's excluded edges. CI runs this as its own job
 * (`bun run bundle-size`); a regression makes it exit non-zero, so the 118 KB
 * react-dom-server-dragging bundle can never silently return.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { buildClient, bunBuildClientDeps, viteBuildClientDeps } from "../src/index";
import type { BuildClientDeps, Dialect } from "../src/index";

/** The gzip budget, in bytes, per dialect — the roadmap's Wave 2 "Done" bar. */
const BUDGET_GZIP_BYTES: Record<Dialect, number> = {
  react: 65 * 1024,
  preact: 15 * 1024,
};

/** The bundler backends to guard: the prod artifact AND the dev fallback. */
const BACKENDS: ReadonlyArray<{
  readonly label: string;
  readonly deps: (appRoot: string) => BuildClientDeps;
}> = [
  { label: "vite (prod)", deps: viteBuildClientDeps },
  { label: "bun (dev fallback)", deps: bunBuildClientDeps },
];

/** Where the fixture island the bundle is measured against lives. */
const FIXTURE_ISLANDS = join(import.meta.dir, "fixture-islands");

/** The repo root, where `@lesto/ui`, `react`, and `preact` all resolve from. */
const APP_ROOT = join(import.meta.dir, "..", "..", "..");

/** Build one backend × dialect production client and return its gzipped entry size in bytes. */
async function measure(
  deps: (appRoot: string) => BuildClientDeps,
  dialect: Dialect,
): Promise<number> {
  const outDir = await mkdtemp(join(tmpdir(), `lesto-bundle-${dialect}-`));

  try {
    const { entry } = await buildClient(
      { islandsDir: FIXTURE_ISLANDS, outDir, mode: "production", dialect },
      deps(APP_ROOT),
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

for (const backend of BACKENDS) {
  for (const dialect of ["react", "preact"] as const) {
    const size = await measure(backend.deps, dialect);
    const budget = BUDGET_GZIP_BYTES[dialect];
    const ok = size <= budget;

    console.log(`${ok ? "✓" : "✗"} ${backend.label} ${dialect}: ${kb(size)} gzip (budget ${kb(budget)})`);

    if (!ok) {
      failures.push(
        `${backend.label} ${dialect} client entry is ${kb(size)} gzip, over the ${kb(budget)} budget`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\nBundle-size assertion failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log("\nBundle-size assertion passed.");
