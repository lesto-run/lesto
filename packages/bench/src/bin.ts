#!/usr/bin/env bun
/**
 * The `bench` executable — pure wiring, no logic.
 *
 * It builds the real side effects (read/write the tracked report files next to
 * this package, the system clock, `console.log`) and hands them to the covered
 * `runReport` core. Every decision — which workloads, how to compare, how to
 * render — lives in `report-run.ts` and its pure dependencies, all unit-tested to
 * 100%. This file holds only the filesystem/argv glue a unit test cannot
 * meaningfully assert without spawning a process, which is exactly why it is the
 * one module excluded from the coverage gate (the `@lesto/cli` `bin.ts` pattern).
 *
 *   bun run --filter @lesto/bench bench
 *   bun run --filter @lesto/bench bench -- --iterations 1000 --concurrency 8
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runReport } from "./report-run";

import type { ReportIo, ReportOptions } from "./report-run";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_MD = join(packageDir, "RESULTS.md");
const RESULTS_JSON = join(packageDir, "results.json");

/** Read a `--flag value` integer out of argv, or `undefined` if absent. */
function intFlag(argv: readonly string[], flag: string): number | undefined {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) {
    return undefined;
  }

  const value = Number(argv[index + 1]);

  return Number.isFinite(value) ? value : undefined;
}

/** Read a `--flag value` string out of argv, or `undefined` if absent. */
function stringFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) {
    return undefined;
  }

  return argv[index + 1];
}

const io: ReportIo = {
  readBaseline: async () => {
    try {
      return await readFile(RESULTS_JSON, "utf8");
    } catch {
      // No recorded baseline yet (first run): treat as "nothing to compare."
      return null;
    }
  },
  writeMarkdown: (markdown) => writeFile(RESULTS_MD, markdown, "utf8"),
  writeJson: (json) => writeFile(RESULTS_JSON, json, "utf8"),
  log: (line) => {
    console.log(line);
  },
  now: () => new Date(),
};

const argv = process.argv.slice(2);

// `ReportOptions` is fully `readonly`, so accumulate the parsed flags in a
// mutable bag and freeze it into the options shape in one pass — only the keys
// that were actually supplied are set, so each falls back to its core default.
const parsed: {
  iterations?: number;
  concurrency?: number;
  warmup?: number;
  ref?: string;
} = {};

const iterations = intFlag(argv, "--iterations");
if (iterations !== undefined) {
  parsed.iterations = iterations;
}

const concurrency = intFlag(argv, "--concurrency");
if (concurrency !== undefined) {
  parsed.concurrency = concurrency;
}

const warmup = intFlag(argv, "--warmup");
if (warmup !== undefined) {
  parsed.warmup = warmup;
}

const ref = stringFlag(argv, "--ref");
if (ref !== undefined) {
  parsed.ref = ref;
}

const options: ReportOptions = parsed;

const artifacts = await runReport(io, options);

console.log(`\nWrote ${RESULTS_MD} and ${RESULTS_JSON}.`);

// A regression exits non-zero so the harness can gate CI when wired to one.
if (artifacts.regressed) {
  process.exitCode = 1;
}
