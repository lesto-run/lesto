#!/usr/bin/env bun
/**
 * The real-server load harness orchestrator.
 *
 *   bun benchmarks/driver/run.ts
 *   bun benchmarks/driver/run.ts --duration 10 --connections 16,64,256 --runs 5 --only lesto,hono
 *   bun benchmarks/driver/run.ts --rate 50000          # constant-rate (coordinated-omission-aware) load
 *   bun benchmarks/driver/run.ts --generator oha --seed 1234
 *
 * Run it with **bun**, not node: this file imports TypeScript (`./apps`, `./parse`)
 * with extensionless specifiers and the Lesto/Elysia apps are TS — node's loader
 * won't resolve those. (The apps it SPAWNS still use node or bun per `apps.ts`.)
 *
 * For each framework app (see `apps.ts`): install + build it once, boot its server
 * on a fresh port, wait until it answers, warm it, then SWEEP a ladder of
 * connection levels — running the load generator `--runs` times per (workload,
 * level) in a SEEDED-RANDOM order to defeat thermal/ordering bias. The median of
 * each rung's trials, its throughput stability (CV), and the curve's max-sustainable
 * req/s (highest throughput held at ≥99.9% success — the real headline) are written
 * to `RESULTS.md`.
 *
 * This is the credible, apples-to-apples request-throughput suite — it cannot run
 * in a sandbox that blocks server starts (it spawns real servers and sockets), so
 * it runs in CI or locally. The PURE parsing/stats/saturation/render it depends on
 * is unit tested in `parse.test.ts`; this file is the impure spawn/poll/kill glue.
 *
 * Default generator is `autocannon` via `npx` (no separate binary needed); pass
 * `--generator oha` to use a locally installed `oha`. With `--rate`, autocannon's
 * `--overallRate` (and oha's `-q`) drive a fixed open-loop rate and autocannon
 * corrects its latency histogram for the coordinated-omission issue.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APPS, WORKLOADS, type AppDef, type Workload } from "./apps";
import { collectEnv, isCanonical, renderProvenance } from "./env";
import {
  assessStability,
  DEFAULT_CV_THRESHOLD,
  medianSample,
  mulberry32,
  PARSERS,
  renderResults,
  shuffle,
  summarizeSaturation,
  SUCCESS_THRESHOLD,
  type ConnectionLevel,
  type LoadSample,
  type ReportMeta,
  type SaturationResult,
} from "./parse";
import { jsonBody, plaintextBody, realisticBody, ssrBody } from "../apps/_contract.mjs";

/** The exact body each workload path must return — the parity oracle (see `../workloads.md`). */
const CONTRACT: Record<string, string> = {
  "/plaintext": plaintextBody,
  "/json": jsonBody,
  "/ssr": ssrBody(),
  // realisticBody() is deterministic — calling it once yields the canonical bytes the
  // apps must reproduce on every (uncached) render.
  "/realistic": realisticBody(),
};

/** The Content-Type prefix each workload must declare — an app that skips real serialization is caught here. */
const CONTRACT_CONTENT_TYPE: Record<string, string> = {
  "/plaintext": "text/plain",
  "/json": "application/json",
  "/ssr": "text/html",
  "/realistic": "text/html",
};

/** The default connection ladder swept when `--connections` isn't given. */
const DEFAULT_CONNECTIONS: readonly number[] = [16, 32, 64, 128, 256];

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_DIR = join(HERE, "..", "apps");
const RESULTS_MD = join(HERE, "..", "RESULTS.md");

interface Options {
  duration: number;
  /** The connection ladder to sweep (ascending) — one rung per level. */
  connections: number[];
  runs: number;
  warmupSeconds: number;
  generator: "autocannon" | "oha";
  only: ReadonlySet<string> | null;
  startTimeoutMs: number;
  /** Constant request rate (req/s) for coordinated-omission-aware load, or null = closed-loop. */
  rateRps: number | null;
  /** Seed for the randomized run order (so the order is reproducible and stamped). */
  seed: number;
  /** Whether to randomize app + trial order (off → deterministic order, for debugging). */
  shuffleOrder: boolean;
  /** CV ceiling (fraction) for the stability gate. */
  cvThreshold: number;
  /** Cores the server (this driver + its spawned servers) is pinned to, for stamping. Set by reproduce.ts. */
  serverCpus: string | null;
  /** Cores to pin the load generator to via taskset, so it doesn't share the server's cores. */
  genCpus: string | null;
}

function intFlag(argv: readonly string[], flag: string, fallback: number): number {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  const v = Number(argv[i + 1]);

  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** A positive integer flag that may be absent entirely (returns null), e.g. `--rate`. */
function optionalIntFlag(argv: readonly string[], flag: string): number | null {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return null;
  const v = Number(argv[i + 1]);

  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** Parse a comma-separated list of positive integers, e.g. `--connections 16,64,256`. */
function intListFlag(argv: readonly string[], flag: string, fallback: readonly number[]): number[] {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return [...fallback];
  const parts = (argv[i + 1] ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));

  return parts.length > 0 ? parts : [...fallback];
}

function parseOptions(argv: readonly string[]): Options {
  const onlyIndex = argv.indexOf("--only");
  const only =
    onlyIndex !== -1 && onlyIndex + 1 < argv.length
      ? new Set(
          (argv[onlyIndex + 1] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      : null;
  const genIndex = argv.indexOf("--generator");
  const generator = genIndex !== -1 && argv[genIndex + 1] === "oha" ? "oha" : "autocannon";
  // A `--cv-threshold 8` (percent) → 0.08 fraction; default 5%.
  const cvPct = intFlag(argv, "--cv-threshold", DEFAULT_CV_THRESHOLD * 100);

  return {
    duration: intFlag(argv, "--duration", 10),
    connections: intListFlag(argv, "--connections", DEFAULT_CONNECTIONS).toSorted((a, b) => a - b),
    runs: intFlag(argv, "--runs", 3),
    warmupSeconds: intFlag(argv, "--warmup", 3),
    generator,
    only,
    startTimeoutMs: intFlag(argv, "--start-timeout", 60_000),
    rateRps: optionalIntFlag(argv, "--rate"),
    // A fixed seed makes the randomized run order reproducible; absent → a random
    // seed is chosen and STAMPED into the report so the run can still be repeated.
    seed: optionalIntFlag(argv, "--seed") ?? Math.floor(Math.random() * 0xffffffff),
    shuffleOrder: !argv.includes("--no-shuffle"),
    cvThreshold: cvPct / 100,
    // Core pinning comes from reproduce.ts via env (the runner pins the driver →
    // server through inherited affinity, and tells the driver which cores to put
    // the generator on so the two don't contend). Empty → unpinned (non-canonical).
    serverCpus: process.env.BENCH_SERVER_CPUS || null,
    genCpus: process.env.BENCH_GEN_CPUS || null,
  };
}

/**
 * Promisify a spawned child's terminal state: resolve on a clean close, reject on
 * a spawn error or non-zero code. We listen on `close` (not `exit`) so a piped
 * stdout is fully drained before we resolve — `capture()` depends on this to not
 * truncate the generator's JSON. The `error` and `close` paths are mutually
 * exclusive at runtime, so this is single-resolution despite the two listeners.
 */
function awaitExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // oxlint-disable-next-line promise/no-multiple-resolved -- error|close are mutually exclusive
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited ${code}`));
      }
    });
  });
}

/** Run a command to completion in `cwd`, inheriting stdio. Rejects on non-zero exit. */
function run(cmd: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(cmd[0] as string, cmd.slice(1), {
    cwd,
    env: env ?? process.env,
    stdio: "inherit",
  });

  return awaitExit(child, cmd.join(" "));
}

/** Run a command and capture stdout (for the load generator's JSON). Rejects on non-zero exit. */
function capture(cmd: readonly string[], cwd: string): Promise<string> {
  const child = spawn(cmd[0] as string, cmd.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout?.on("data", (chunk) => {
    out += String(chunk);
  });

  return awaitExit(child, cmd.join(" ")).then(() => out);
}

/** Poll `url` until it answers 2xx or the deadline passes. */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        await res.arrayBuffer();

        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Assert every workload returns the contract body, EXACTLY. A framework that
 * emits different bytes is not doing the same work — recording its throughput
 * would be comparing apples to oranges, so this throws and the app is reported as
 * failed instead of polluting the table.
 */
async function verifyParity(baseUrl: string): Promise<void> {
  for (const [path, expected] of Object.entries(CONTRACT)) {
    const res = await fetch(`${baseUrl}${path}`);

    // Compression parity (the bug the Platformatic "corrected results" post fixed):
    // one app gzipping while another doesn't makes the wire bytes — and the req/s —
    // incomparable. Every app must serve UNCOMPRESSED. fetch() auto-decompresses the
    // body, so we check the raw header, not the decoded length.
    const encoding = res.headers.get("content-encoding");
    if (encoding && encoding !== "identity") {
      throw new Error(
        `compression mismatch at ${path}: Content-Encoding=${encoding}. Every app must serve ` +
          `uncompressed (disable compression middleware) so the comparison is fair.`,
      );
    }

    // Content-Type parity: an app that returns the right bytes with the wrong type may
    // have skipped real serialization (e.g. /json served as text/plain) — not the same work.
    const contentType = res.headers.get("content-type") ?? "";
    const expectedType = CONTRACT_CONTENT_TYPE[path] as string;
    if (!contentType.startsWith(expectedType)) {
      throw new Error(
        `content-type mismatch at ${path}: expected ${expectedType}, got ${JSON.stringify(contentType)}.`,
      );
    }

    const body = await res.text();
    if (body !== expected) {
      throw new Error(
        `parity mismatch at ${path}: expected ${JSON.stringify(expected.slice(0, 60))}, ` +
          `got ${JSON.stringify(body.slice(0, 60))}`,
      );
    }
  }
}

/**
 * Build the load generator argv for one workload URL at a given concurrency. With a
 * `rateRps`, the generator runs OPEN-LOOP at a fixed rate — autocannon's
 * `--overallRate` (or oha's `-q`): it keeps sending on schedule instead of backing
 * off when the server stalls, the structural mitigation for coordinated omission.
 * autocannon ADDITIONALLY back-corrects its latency histogram for coordinated
 * omission when rate-limited (so it's the CO-rigorous default); oha's `-q` paces the
 * rate but reports observed latency, with no histogram correction.
 */
function generatorCmd(
  opts: Options,
  url: string,
  connections: number,
  durationSeconds: number,
  rateRps: number | null,
): string[] {
  const base =
    opts.generator === "oha"
      ? [
          "oha",
          "--no-tui",
          "-j",
          "-z",
          `${durationSeconds}s`,
          "-c",
          String(connections),
          ...(rateRps != null ? ["-q", String(rateRps)] : []),
          url,
        ]
      : // autocannon: prefers the pinned local install (benchmarks/node_modules), else fetches.
        [
          "npx",
          "--yes",
          "autocannon",
          "-j",
          "-c",
          String(connections),
          "-d",
          String(durationSeconds),
          ...(rateRps != null ? ["-R", String(rateRps)] : []),
          url,
        ];

  // Pin the generator to its own cores so it doesn't steal cycles from the server.
  // The driver (and its spawned servers) inherit the server core set from reproduce.ts;
  // this taskset OVERRIDES that inherited mask for the generator only. Linux-only —
  // unset on macOS/dev, where the run is non-canonical anyway.
  return opts.genCpus ? ["taskset", "-c", opts.genCpus, ...base] : base;
}

/** A single measurement unit in the randomized schedule: one trial of one (workload, rung). */
interface TrialUnit {
  readonly workload: Workload;
  readonly connections: number;
}

/** Bucket key for a (workload, rung)'s repeated trials. */
function cellKey(workload: string, connections: number): string {
  return `${workload}|${connections}`;
}

/** A deterministic 32-bit FNV-1a hash of a string — used to derive a per-app run-order seed. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return h >>> 0;
}

/**
 * Benchmark one app end-to-end: prepare, boot, probe, warm every workload, then run
 * the WHOLE (workload × connection-rung × trial) schedule in a seeded-random order
 * (so no rung is systematically measured cold-first or hot-last), and reduce each
 * rung to its median + stability and each (app, workload) to its saturation curve.
 */
async function benchApp(app: AppDef, port: number, opts: Options): Promise<SaturationResult[]> {
  const cwd = join(APPS_DIR, app.dir);
  const baseUrl = `http://127.0.0.1:${port}`;
  const parse = PARSERS[opts.generator] as (json: string) => LoadSample;
  // Derive this app's run-order RNG from (seed, app name) — NOT the shared stream —
  // so a given app's trial order depends only on the seed, never on which other apps
  // ran (`--only`) or in what order. That keeps the stamped seed reproducible per app.
  const appRng = mulberry32((opts.seed ^ hashString(app.name)) >>> 0);

  console.log(`\n=== ${app.name} (port ${port}) ===`);
  for (const step of app.prepare) {
    console.log(`  prepare: ${step.join(" ")}`);
    await run(step, cwd);
  }

  console.log(`  start: ${app.start.join(" ")}`);
  const server = spawn(app.start[0] as string, app.start.slice(1), {
    cwd,
    env: { ...process.env, ...app.env, PORT: String(port) },
    stdio: ["ignore", "inherit", "inherit"],
  });

  try {
    await waitForReady(`${baseUrl}/plaintext`, opts.startTimeoutMs);
    await verifyParity(baseUrl);
    console.log("  ready + parity OK — warming + sweeping...");

    // Warm each workload once at the top of the ladder (JIT, connection pools) — timed
    // and thrown away — before any recorded trial, so warmup isn't mixed into the data.
    const warmConns = Math.max(...opts.connections);
    for (const workload of WORKLOADS) {
      await capture(
        generatorCmd(opts, `${baseUrl}${workload.path}`, warmConns, opts.warmupSeconds, null),
        HERE,
      );
    }

    // Build the full schedule (every workload × rung × trial) and randomize its order.
    const units: TrialUnit[] = [];
    for (const workload of WORKLOADS) {
      for (const connections of opts.connections) {
        for (let t = 0; t < opts.runs; t += 1) {
          units.push({ workload, connections });
        }
      }
    }
    const schedule = opts.shuffleOrder ? shuffle(units, appRng) : units;

    const byCell = new Map<string, LoadSample[]>();
    for (const unit of schedule) {
      const url = `${baseUrl}${unit.workload.path}`;
      const json = await capture(
        generatorCmd(opts, url, unit.connections, opts.duration, opts.rateRps),
        HERE,
      );
      const key = cellKey(unit.workload.name, unit.connections);
      const list = byCell.get(key) ?? [];
      list.push(parse(json));
      byCell.set(key, list);
    }

    // Reduce: each rung → median + stability; each (app, workload) → saturation curve.
    const results: SaturationResult[] = [];
    for (const workload of WORKLOADS) {
      const levels: ConnectionLevel[] = opts.connections.map((connections) => {
        const samples = byCell.get(cellKey(workload.name, connections)) ?? [];

        return {
          connections,
          sample: medianSample(samples),
          stability: assessStability(
            samples.map((s) => s.requestsPerSec),
            opts.cvThreshold,
          ),
        };
      });
      const saturation = summarizeSaturation(app.name, workload.name, levels, SUCCESS_THRESHOLD);
      const peak =
        saturation.maxSustainableRps > 0
          ? `${saturation.maxSustainableRps.toFixed(0)} req/s @ ${saturation.maxSustainableAt}c` +
            (saturation.saturated ? "" : " (still climbing)")
          : "none sustained (dropped requests at every rung)";
      console.log(`  ${workload.name.padEnd(10)} max sustainable: ${peak}`);
      results.push(saturation);
    }

    return results;
  } finally {
    server.kill("SIGTERM");
    // Give it a moment to release the port before the next app binds one.
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const selectedDefs = APPS.filter((a) => (opts.only ? opts.only.has(a.name) : true));
  const rng = mulberry32(opts.seed);
  // Randomize app order too — distributes the cold-CPU-first / hot-CPU-last bias
  // across frameworks instead of always penalizing whoever's listed first.
  const selected = opts.shuffleOrder ? shuffle(selectedDefs, rng) : selectedDefs;

  console.log(
    `Real-server benchmark — generator=${opts.generator}, duration=${opts.duration}s, ` +
      `ladder=${opts.connections.join("/")}c, runs=${opts.runs} (median), ` +
      `${opts.rateRps != null ? `rate=${opts.rateRps} req/s (CO-aware)` : "closed-loop"}, seed=${opts.seed}`,
  );

  const all: SaturationResult[] = [];
  let port = 3100;
  for (const app of selected) {
    if (app.status === "scaffold") {
      console.log(`\n=== ${app.name} === SKIPPED (scaffold — app not implemented yet)`);
      continue;
    }
    try {
      all.push(...(await benchApp(app, port, opts)));
    } catch (error) {
      console.error(`  ${app.name} FAILED: ${(error as Error).message}`);
    }
    port += 1;
  }

  if (all.length === 0) {
    console.error("\nNo results — every selected app was skipped or failed.");
    process.exitCode = 1;

    return;
  }

  const recordedAt = new Date().toISOString();

  // Stamp the run's own provenance into the report — git SHA, real CPU/RAM/OS,
  // resolved tool + framework versions, and the OBSERVED isolation state — so the
  // numbers carry their conditions instead of trusting a hand-filled README matrix.
  const frameworks = [...new Set(all.map((r) => r.framework))].map((name) => {
    const def = APPS.find((a) => a.name === name);

    return {
      name,
      dir: def?.dir ?? name,
      // Lesto variants resolve @lesto/* from the repo root → the git SHA is the version;
      // a competitor's package name is its own name (hono/fastify/express/elysia).
      pkg: name.startsWith("lesto") ? null : name,
    };
  });

  const env = await collectEnv({
    recordedAt,
    generator: opts.generator,
    appsDir: APPS_DIR,
    frameworks,
    serverCpus: opts.serverCpus,
    genCpus: opts.genCpus,
  });

  const meta: ReportMeta = {
    recordedAt,
    runs: opts.runs,
    seed: opts.seed,
    rateRps: opts.rateRps,
    connections: opts.connections,
    cvThresholdPct: Math.round(opts.cvThreshold * 100),
  };
  const markdown = `${renderResults(all, meta)}\n${renderProvenance(env)}`;
  await writeFile(RESULTS_MD, markdown, "utf8");
  console.log(`\n${markdown}`);
  console.log(`Wrote ${RESULTS_MD}`);
  if (!isCanonical(env)) {
    console.log(
      "\n⚠️  Non-canonical host — indicative numbers only. For publication-grade results run\n" +
        "    `bun benchmarks/driver/reproduce.ts --strict` on the documented rig (README → Reproduce it yourself).",
    );
  }
}

await main();
