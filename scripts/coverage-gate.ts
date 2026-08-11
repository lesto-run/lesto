#!/usr/bin/env bun
/**
 * Coverage gate — runs each gated package's 100%-threshold suite SERIALLY.
 *
 * Serial is deliberate, not lazy. Bun's `--filter` runs every workspace package
 * concurrently with no throttle, and v8 coverage instrumentation roughly halves
 * execution speed. Together they oversubscribe the CPU enough to make
 * timing-sensitive tests non-deterministic — and not just flaky pass/fail, but
 * flaky *coverage %*: a branch that is reliably exercised in isolation gets
 * starved past a wall-clock deadline (a real `setTimeout`) and is recorded as
 * uncovered. Every gated package reaches 100% on its own; running them one at a
 * time is what makes the gate reproduce that on a busy CI runner.
 *
 * Scope: every package that declares a `test:cov` script, EXCEPT the folded-in
 * `content-*` suites — frozen Docks baselines that declare no thresholds and are
 * ratcheted up separately (see CONTENT_COVERAGE.md). `@lesto/integration` and
 * `@lesto/e2e` declare no `test:cov` and are skipped automatically; they run as
 * their own (non-gated) CI steps. The gate PRINTS this scope at the start of
 * every run, so the enforced-vs-exempt split is visible on every run — not only
 * under audit (CONVENTIONS.md "Coverage scope" states the same split).
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packagesDir = new URL("../packages/", import.meta.url).pathname;

// Classify first, so the gate can state its own scope before the first suite runs.
const gated: { name: string; dir: string }[] = [];
const contentExempt: string[] = [];
const noTestCov: string[] = [];

for (const dir of readdirSync(packagesDir).sort()) {
  let pkg: { name?: string; scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(`${packagesDir}${dir}/package.json`, "utf8"));
  } catch {
    continue; // not a package directory
  }

  const name = pkg.name ?? dir;
  if (dir.startsWith("content-")) {
    contentExempt.push(name);
    continue;
  }
  if (!pkg.scripts?.["test:cov"]) {
    noTestCov.push(name);
    continue;
  }
  gated.push({ name, dir });
}

console.log(`coverage gate scope: ${gated.length} packages enforced at 100% thresholds`);
console.log(
  `  exempt (${contentExempt.length}) content-* — frozen Docks baselines, ratcheted separately (CONTENT_COVERAGE.md): ${contentExempt.join(", ")}`,
);
console.log(
  `  skipped (${noTestCov.length}) no test:cov script — run as their own non-gated CI steps: ${noTestCov.join(", ")}`,
);

const failed: string[] = [];

for (const { name, dir } of gated) {
  console.log(`\n── coverage gate: ${name}`);
  const { status } = spawnSync("bun", ["run", "test:cov"], {
    cwd: `${packagesDir}${dir}`,
    stdio: "inherit",
  });
  if (status !== 0) failed.push(name);
}

if (failed.length > 0) {
  console.error(`\nCoverage gate failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("\nCoverage gate passed.");
