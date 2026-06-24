#!/usr/bin/env bun
/**
 * The one-command reproducible runner.
 *
 *   bun benchmarks/driver/reproduce.ts            # dev: warn on a noisy host, run anyway
 *   bun benchmarks/driver/reproduce.ts --strict   # publish: REFUSE unless the host is canonical
 *   bun benchmarks/driver/reproduce.ts --server-cpus 2,3 --gen-cpus 4,5 --duration 30 --connections 100 --runs 5 --only lesto,lesto-bare,hono
 *
 * What it does, in order:
 *   1. Probe the host (governor, turbo, taskset, core count) and print a readiness
 *      checklist. Under `--strict`, ABORT if the host isn't publication-grade — it
 *      never silently changes the governor/turbo (that's a documented root step;
 *      see README → "Reproduce it yourself").
 *   2. Pick two disjoint core sets (server vs generator) so they never contend.
 *   3. Run the driver pinned: `taskset -c <server> bun driver/run.ts …` — the driver
 *      and the servers it spawns inherit the server cores; the driver re-pins the
 *      generator to its cores via `BENCH_GEN_CPUS`. The driver then stamps the
 *      OBSERVED conditions into `RESULTS.md`.
 *
 * This pins cores and tells the truth about what it pinned. It does NOT carve
 * cgroups, set governors, or edit the kernel cmdline — those are documented host
 * steps, by design (`checkHostReadiness` reports them; the doc fixes them).
 *
 * Run with bun (it's TypeScript and invokes the TS driver).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkHostReadiness } from "./env";

// Repo root: benchmarks/driver/ → up two. The driver's relative paths + workspace
// resolution expect to run from here.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const argv = process.argv.slice(2);

function stringFlag(flag: string): string | undefined {
  const i = argv.indexOf(flag);

  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const strict = argv.includes("--strict");

/** Default core split for a ≥6-core box: leave 0,1 for the OS; server 2,3; generator 4,5. */
function defaultCores(cores: number): { server: string; gen: string } {
  if (cores >= 6) {
    return { server: "2,3", gen: "4,5" };
  }
  if (cores >= 4) {
    return { server: "2", gen: "3" };
  }

  // Too few cores to split — leave unpinned (the driver stamps this as non-canonical).
  return { server: "", gen: "" };
}

async function main(): Promise<void> {
  const host = await checkHostReadiness();
  const cores = defaultCores(host.cores);
  const serverCpus = stringFlag("--server-cpus") ?? cores.server;
  const genCpus = stringFlag("--gen-cpus") ?? cores.gen;

  console.log("Host readiness:");
  console.log(
    `  OS: ${host.linux ? "Linux" : "non-Linux"}  cores: ${host.cores}  taskset: ${host.hasTaskset ? "yes" : "no"}`,
  );
  const governorLabel =
    host.governor === null
      ? "unknown"
      : host.governorUniform === false
        ? `${host.governor} (mixed across cores)`
        : host.governor;
  console.log(`  governor: ${governorLabel}  turbo-disabled: ${host.turboDisabled ?? "unknown"}`);
  if (host.issues.length === 0) {
    console.log("  ✓ canonical host — publication-grade conditions met.");
  } else {
    console.log("  ⚠️ NOT canonical:");
    for (const issue of host.issues) {
      console.log(`     - ${issue}`);
    }
    console.log(
      '  Fix the host first (README → "Reproduce it yourself"): governor=performance, turbo off.',
    );
  }

  if (strict && host.issues.length > 0) {
    console.error(
      "\n--strict: refusing to produce publication-grade numbers on a non-canonical host.",
    );
    process.exitCode = 1;

    return;
  }

  // Forward everything except our own `--strict` to the driver. The driver reads
  // only the flags it recognizes (duration/connections/runs/only/generator/...) and
  // takes the core sets via env (BENCH_*_CPUS), so a leftover `--server-cpus 2,3`
  // is harmless — no need for a brittle positional strip.
  const passthrough = argv.filter((a) => a !== "--strict");

  // Pin the driver (→ the servers it spawns) to the server cores via taskset, if we
  // have it and a set; the driver re-pins the generator via BENCH_GEN_CPUS.
  const pin = host.hasTaskset && serverCpus ? ["taskset", "-c", serverCpus] : [];
  const cmd = [...pin, "bun", "benchmarks/driver/run.ts", ...passthrough];

  console.log(`\nRunning: ${cmd.join(" ")}`);
  console.log(
    `  (server cores: ${serverCpus || "unpinned"}, generator cores: ${genCpus || "unpinned"})\n`,
  );

  const child = spawn(cmd[0] as string, cmd.slice(1), {
    cwd: REPO_ROOT,
    env: { ...process.env, BENCH_SERVER_CPUS: serverCpus, BENCH_GEN_CPUS: genCpus },
    stdio: "inherit",
  });

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      // A signal-killed driver (SIGTERM/SIGKILL/OOM) has code === null — that's a
      // FAILED run, not success. Surface it as non-zero so CI never reads a killed
      // benchmark as passed.
      process.exitCode = signal ? 1 : (code ?? 0);
      resolve();
    });
    child.on("error", (err) => {
      console.error(`failed to launch the driver: ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
}

await main();
