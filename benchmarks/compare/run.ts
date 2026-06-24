#!/usr/bin/env bun
/**
 * Run the in-process cross-framework comparisons and write `COMPARISON.md`.
 *
 *   bun run benchmarks/compare/run.ts
 *   bun run benchmarks/compare/run.ts --iterations 5000 --warmup 500 --rows 100
 *
 * This drives each contender through `@lesto/bench`'s `runBench` — same runner,
 * same iteration budget, same machine, back to back — then ranks and renders the
 * results. These are volatile in-process micro-benchmarks (see `rank.ts`'s
 * header): read the ranking and the gap, not the absolute ops/sec.
 *
 * Pure-wiring only (argv, the system clock, disk, `console.log`): every measured
 * code path and the ranking math live in the imported modules.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBench } from "@lesto/bench";

import { buildDispatchContenders } from "./dispatch";
import { renderComparison } from "./rank";
import { lestoRouterSample, findMyWayRouterSample } from "./router";
import { DEFAULT_SSR_ROWS, lestoRegistrySsrSample, preactSsrSample, reactSsrSample } from "./ssr";

import type { ComparisonSection } from "./rank";
import type { RunResult, SampleSource } from "@lesto/bench";

function intFlag(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) {
    return fallback;
  }
  const value = Number(argv[index + 1]);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const argv = process.argv.slice(2);
const iterations = intFlag(argv, "--iterations", 2000);
const warmup = intFlag(argv, "--warmup", Math.max(1, Math.floor(iterations / 10)));
const rows = intFlag(argv, "--rows", DEFAULT_SSR_ROWS);

/** Time one named contender through the shared runner. */
async function measure(name: string, source: SampleSource): Promise<RunResult> {
  return runBench(source, { name, iterations, warmup });
}

const ssrResults: RunResult[] = [
  await measure("react", reactSsrSample(rows)),
  await measure("preact", preactSsrSample(rows)),
  await measure("lesto-registry", lestoRegistrySsrSample(rows)),
];

const routerContenders: Array<readonly [string, SampleSource]> = [["lesto", lestoRouterSample()]];
const findMyWay = await findMyWayRouterSample();
if (findMyWay) {
  routerContenders.push(["find-my-way", findMyWay]);
}

const routerResults: RunResult[] = [];
for (const [name, source] of routerContenders) {
  routerResults.push(await measure(name, source));
}

// Cross-framework in-process dispatch (Lesto vs Hono/Elysia/Fastify, whatever is installed).
const dispatchContenders = await buildDispatchContenders();
const dispatchJson: RunResult[] = [];
const dispatchPlaintext: RunResult[] = [];
for (const contender of dispatchContenders) {
  dispatchJson.push(await measure(contender.name, contender.json));
  dispatchPlaintext.push(await measure(contender.name, contender.plaintext));
}
const skipped = ["hono", "elysia", "fastify"].filter(
  (name) => !dispatchContenders.some((c) => c.name === name),
);
const dispatchCaveat =
  "⚠️ Not identical work: `lesto-bare` returns a plain object; Hono/Elysia build + drain a web " +
  "`Response`; Fastify uses light-my-request. A faster number can mean *did less*. `lesto-bare` is " +
  "Lesto with the secure stack OFF (a secure-on in-process row would just measure rate-limit 429s on " +
  "a shared bucket). The apples-to-apples comparison — real socket, success-rate, tail latency, and " +
  "the secure stack's real cost — is the real-server suite in `../driver`." +
  (skipped.length ? ` Skipped (not installed): ${skipped.join(", ")}.` : "");

const sections: ComparisonSection[] = [
  {
    title: `SSR render (${rows}-row list → HTML)`,
    note:
      "All paths emit byte-identical markup. `react`/`preact` are the raw renderers; `lesto-registry` " +
      "is Lesto's `renderPage`→`renderPageMarkup` JSON-UI path (it validates every node's props per " +
      "render), so its number shows that path's overhead over the raw renderer. There is no bare " +
      "`lesto` row: Lesto's plain-component renderer IS `react-dom/server`, so it renders at `react`'s " +
      "speed by construction — timing it would just re-time the `react` row.",
    results: ssrResults,
  },
  {
    title: "Route match (mixed request stream)",
    note: findMyWay
      ? "Lesto's compiled-RegExp `RouteTable` vs `find-my-way`'s radix tree on the same 12-request stream. " +
        "NOT strictly equal work: Lesto URL-decodes every captured param at match time; find-my-way decodes " +
        "lazily (only when the path contains `%`), so on these un-encoded paths it does less."
      : "`find-my-way` not installed — showing Lesto alone. Run `bun install` in `benchmarks/` to include it.",
    results: routerResults,
  },
  {
    title: "Request dispatch — JSON (in-process, NOT apples-to-apples)",
    note: dispatchCaveat,
    results: dispatchJson,
  },
  {
    title: "Request dispatch — plaintext (in-process, NOT apples-to-apples)",
    note: dispatchCaveat,
    results: dispatchPlaintext,
  },
];

const markdown = renderComparison(sections, new Date().toISOString());

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "COMPARISON.md");
await writeFile(outPath, markdown, "utf8");

console.log(markdown);
console.log(`\nWrote ${outPath}`);
console.log(`(iterations=${iterations}, warmup=${warmup}, rows=${rows})`);
