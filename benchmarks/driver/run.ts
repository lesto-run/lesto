#!/usr/bin/env bun
/**
 * The real-server load harness orchestrator.
 *
 *   bun benchmarks/driver/run.ts
 *   bun benchmarks/driver/run.ts --duration 10 --connections 50 --runs 3 --only lesto,hono
 *   bun benchmarks/driver/run.ts --generator oha
 *
 * Run it with **bun**, not node: this file imports TypeScript (`./apps`, `./parse`)
 * with extensionless specifiers and the Lesto/Elysia apps are TS — node's loader
 * won't resolve those. (The apps it SPAWNS still use node or bun per `apps.ts`.)
 *
 * For each framework app (see `apps.ts`): install + build it once, boot its
 * server on a fresh port, wait until it answers, warm it, then run the load
 * generator `--runs` times against each workload and keep the MEDIAN. Results are
 * ranked per workload and written to `RESULTS.md` next to this package.
 *
 * This is the credible, apples-to-apples request-throughput suite — it cannot run
 * in a sandbox that blocks server starts (it spawns real servers and sockets), so
 * it runs in CI or locally. The PURE parsing/median/ranking it depends on is unit
 * tested in `parse.test.ts`; this file is the impure spawn/poll/kill glue.
 *
 * Default generator is `autocannon` via `npx` (no separate binary needed); pass
 * `--generator oha` to use a locally installed `oha`.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APPS, WORKLOADS, type AppDef } from "./apps";
import {
  medianSample,
  PARSERS,
  renderResults,
  type FrameworkResult,
  type LoadSample,
} from "./parse";
import { jsonBody, plaintextBody, ssrBody } from "../apps/_contract.mjs";

/** The exact body each workload path must return — the parity oracle (see `../workloads.md`). */
const CONTRACT: Record<string, string> = {
  "/plaintext": plaintextBody,
  "/json": jsonBody,
  "/ssr": ssrBody(),
};

/** The Content-Type prefix each workload must declare — an app that skips real serialization is caught here. */
const CONTRACT_CONTENT_TYPE: Record<string, string> = {
  "/plaintext": "text/plain",
  "/json": "application/json",
  "/ssr": "text/html",
};

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_DIR = join(HERE, "..", "apps");
const RESULTS_MD = join(HERE, "..", "RESULTS.md");

interface Options {
  duration: number;
  connections: number;
  runs: number;
  warmupSeconds: number;
  generator: "autocannon" | "oha";
  only: ReadonlySet<string> | null;
  startTimeoutMs: number;
}

function intFlag(argv: readonly string[], flag: string, fallback: number): number {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  const v = Number(argv[i + 1]);

  return Number.isFinite(v) && v > 0 ? v : fallback;
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

  return {
    duration: intFlag(argv, "--duration", 10),
    connections: intFlag(argv, "--connections", 50),
    runs: intFlag(argv, "--runs", 3),
    warmupSeconds: intFlag(argv, "--warmup", 3),
    generator,
    only,
    startTimeoutMs: intFlag(argv, "--start-timeout", 60_000),
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

/** Build the load generator argv for one workload URL. */
function generatorCmd(opts: Options, url: string): string[] {
  if (opts.generator === "oha") {
    return [
      "oha",
      "--no-tui",
      "-j",
      "-z",
      `${opts.duration}s`,
      "-c",
      String(opts.connections),
      url,
    ];
  }

  // autocannon via npx: no separate binary required in CI.
  return [
    "npx",
    "--yes",
    "autocannon",
    "-j",
    "-c",
    String(opts.connections),
    "-d",
    String(opts.duration),
    url,
  ];
}

/** Drive one workload `--runs` times and return the median sample. */
async function loadWorkload(opts: Options, baseUrl: string, path: string): Promise<LoadSample> {
  const url = `${baseUrl}${path}`;
  const parse = PARSERS[opts.generator] as (json: string) => LoadSample;

  // Warm the path first (timed-and-thrown-away), then take the recorded runs.
  await capture(generatorCmd({ ...opts, duration: opts.warmupSeconds }, url), HERE);

  const samples: LoadSample[] = [];
  for (let i = 0; i < opts.runs; i += 1) {
    const json = await capture(generatorCmd(opts, url), HERE);
    samples.push(parse(json));
  }

  return medianSample(samples);
}

/** Benchmark one app end-to-end: prepare, boot, probe, load every workload, stop. */
async function benchApp(app: AppDef, port: number, opts: Options): Promise<FrameworkResult[]> {
  const cwd = join(APPS_DIR, app.dir);
  const baseUrl = `http://127.0.0.1:${port}`;

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
    console.log("  ready + parity OK — loading workloads...");

    const results: FrameworkResult[] = [];
    for (const workload of WORKLOADS) {
      const sample = await loadWorkload(opts, baseUrl, workload.path);
      console.log(
        `  ${workload.name.padEnd(10)} ${sample.requestsPerSec.toFixed(0).padStart(10)} req/s  ` +
          `p99=${sample.p99Ms.toFixed(2)}ms`,
      );
      results.push({ framework: app.name, workload: workload.name, sample });
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
  const selected = APPS.filter((a) => (opts.only ? opts.only.has(a.name) : true));

  console.log(
    `Real-server benchmark — generator=${opts.generator}, duration=${opts.duration}s, ` +
      `connections=${opts.connections}, runs=${opts.runs} (median)`,
  );

  const all: FrameworkResult[] = [];
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

  const markdown = renderResults(all, new Date().toISOString());
  await writeFile(RESULTS_MD, markdown, "utf8");
  console.log(`\n${markdown}`);
  console.log(`Wrote ${RESULTS_MD}`);
}

await main();
