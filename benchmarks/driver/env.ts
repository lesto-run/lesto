/**
 * Run provenance — the reproducibility primitive.
 *
 * A benchmark number is only trustworthy if the report says, unfalsifiably, the
 * conditions it was produced under. The harness already enforces *fairness*
 * (parity, median, success-rate); this module makes the report enforce *honesty
 * about its environment*: the git SHA, the real CPU/RAM/OS, the resolved tool and
 * framework versions, and — critically — the OBSERVED CPU-isolation state
 * (governor, turbo, core pinning), not what someone hand-typed into a README.
 *
 * Split, mirroring `parse.ts`: `renderProvenance` is PURE (a `BenchEnv` → markdown
 * block) and unit-tested; `collectEnv` is the impure gatherer (reads `os`, shells
 * `git`/`node`, reads `/sys` and resolved `package.json`s) and runs only on a real
 * host. A run is "canonical" (publication-grade) only when it's on Linux with the
 * performance governor, turbo disabled, AND both server + generator pinned to
 * disjoint cores — otherwise the block carries a loud ⚠️ that the number is
 * indicative, not publishable.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Everything the report stamps about the conditions a run was produced under. */
export interface BenchEnv {
  /** ISO-8601 timestamp of the run. */
  readonly recordedAt: string;
  /** Short git SHA the Lesto app was built from (its "version"), or null if unavailable. */
  readonly gitSha: string | null;
  /** CPU model string (e.g. "Apple M2", "AMD EPYC 7763"). */
  readonly cpuModel: string;
  /** Logical core count. */
  readonly cpuCores: number;
  /** Total RAM in GiB, one decimal. */
  readonly memGiB: number;
  /** `${platform} ${release} ${arch}`. */
  readonly os: string;
  /** Bun version, or null. */
  readonly bunVersion: string | null;
  /** Node version used for the competitor apps + generator, or null. */
  readonly nodeVersion: string | null;
  /** Load generator name (e.g. "autocannon"). */
  readonly generator: string;
  /** Resolved generator version, or null. */
  readonly generatorVersion: string | null;
  /** Resolved version per framework that ran (lesto* → the git SHA). */
  readonly frameworkVersions: Readonly<Record<string, string>>;
  /** CPU scaling governor (Linux), or null on non-Linux / unreadable. */
  readonly governor: string | null;
  /** Whether turbo/boost is disabled (Linux): true/false, or null if unknown. */
  readonly turboDisabled: boolean | null;
  /** The core set the server was pinned to via taskset, or null if unpinned. */
  readonly serverCpus: string | null;
  /** The core set the generator was pinned to via taskset, or null if unpinned. */
  readonly genCpus: string | null;
}

/**
 * Is this a publication-grade run? Only on Linux with the performance governor,
 * turbo disabled, and BOTH server and generator pinned to disjoint cores. Anything
 * less is indicative-only and must be flagged.
 */
export function isCanonical(env: BenchEnv): boolean {
  return (
    env.governor === "performance" &&
    env.turboDisabled === true &&
    env.serverCpus !== null &&
    env.genCpus !== null
  );
}

/** Render a nullable cell value, showing "unknown" rather than a blank for an absent probe. */
function fmt(value: string | null): string {
  return value ?? "unknown";
}

/**
 * Render the provenance block appended to `RESULTS.md`. PURE and deterministic for
 * fixed input. A non-canonical run leads with an unmissable ⚠️ banner so the
 * numbers can never be quoted as publication-grade by accident.
 */
export function renderProvenance(env: BenchEnv): string {
  const canonical = isCanonical(env);

  const banner = canonical
    ? []
    : [
        "> ⚠️ **NON-CANONICAL HOST — indicative numbers, NOT publication-grade.** They were not",
        "> produced under the controlled conditions (Linux, performance governor, turbo off, pinned",
        "> cores). Re-run on the documented rig with `bun benchmarks/driver/reproduce.ts --strict`",
        '> (see `README.md` → "Reproduce it yourself"). Do not publish these as a comparison.',
        "",
      ];

  const turbo =
    env.turboDisabled === null ? "unknown" : env.turboDisabled ? "disabled" : "ENABLED ⚠️";
  const pinning =
    env.serverCpus && env.genCpus ? `server=${env.serverCpus} generator=${env.genCpus}` : "none ⚠️";
  const frameworks = Object.entries(env.frameworkVersions)
    .map(([name, version]) => `${name} ${version}`)
    .join(", ");

  return [
    "## Run provenance",
    "",
    ...banner,
    "| Field | Value |",
    "| --- | --- |",
    `| recorded | ${env.recordedAt} |`,
    `| commit | ${fmt(env.gitSha)} |`,
    `| CPU | ${env.cpuModel} (${env.cpuCores} cores) |`,
    `| memory | ${env.memGiB.toFixed(1)} GiB |`,
    `| OS | ${env.os} |`,
    `| Bun | ${fmt(env.bunVersion)} |`,
    `| Node | ${fmt(env.nodeVersion)} |`,
    `| generator | ${env.generator} ${fmt(env.generatorVersion)} |`,
    `| governor | ${fmt(env.governor)}${env.governor !== null && env.governor !== "performance" ? " ⚠️" : ""} |`,
    `| turbo/boost | ${turbo} |`,
    `| core pinning | ${pinning} |`,
    `| frameworks | ${frameworks || "—"} |`,
    "",
  ].join("\n");
}

/** Read a `key` (single-line) out of a Linux `/sys` file, or null if unreadable. */
async function readSys(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Capture a command's trimmed stdout, or null if it fails (tool absent, non-zero). */
async function tryExec(cmd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args as string[]);

    return stdout.trim();
  } catch {
    return null;
  }
}

/** Read the `version` field of `<modulesParent>/node_modules/<pkg>/package.json`, or null. */
async function pkgVersion(modulesParent: string, pkg: string): Promise<string | null> {
  try {
    const json = await readFile(join(modulesParent, "node_modules", pkg, "package.json"), "utf8");

    return (JSON.parse(json) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the load generator's version, single-line (so it never breaks the markdown
 * cell). autocannon is a pinned `benchmarks/` dep → read its package.json; oha is a
 * system binary → take the first line of `oha --version`.
 */
async function generatorVersion(generator: string, benchmarksDir: string): Promise<string | null> {
  if (generator === "autocannon") {
    return pkgVersion(benchmarksDir, "autocannon");
  }
  const out = await tryExec(generator, ["--version"]);

  return out?.split("\n")[0]?.trim() ?? null;
}

/**
 * Read the Linux CPU governor + turbo state. Returns `{ null, null }` on non-Linux
 * or when the files aren't readable — the report then shows "unknown" and the run
 * is treated as non-canonical (the honest default).
 */
async function readIsolation(): Promise<{
  governor: string | null;
  turboDisabled: boolean | null;
}> {
  if (platform() !== "linux") {
    return { governor: null, turboDisabled: null };
  }

  const governor = await readSys("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor");

  // Intel: intel_pstate/no_turbo (1 = turbo OFF). Generic acpi-cpufreq: cpufreq/boost (0 = OFF).
  const noTurbo = await readSys("/sys/devices/system/cpu/intel_pstate/no_turbo");
  if (noTurbo !== null) {
    return { governor, turboDisabled: noTurbo === "1" };
  }
  const boost = await readSys("/sys/devices/system/cpu/cpufreq/boost");
  if (boost !== null) {
    return { governor, turboDisabled: boost === "0" };
  }

  return { governor, turboDisabled: null };
}

/** What the runner learns about the host before deciding whether a run is publication-grade. */
export interface HostReadiness {
  readonly linux: boolean;
  readonly cores: number;
  readonly governor: string | null;
  readonly turboDisabled: boolean | null;
  readonly hasTaskset: boolean;
  /** Human-readable reasons the host is NOT canonical (empty = good to publish). */
  readonly issues: string[];
}

/**
 * Probe the host for publication-grade conditions: Linux, performance governor,
 * turbo disabled, `taskset` available, and ≥4 cores (two disjoint sets for server +
 * generator). Pure reporting — it NEVER mutates host state (setting the governor or
 * disabling turbo is a documented root step, not something a benchmark tool should
 * silently do). `reproduce.ts` prints `issues` and, under `--strict`, refuses to run.
 */
export async function checkHostReadiness(): Promise<HostReadiness> {
  const linux = platform() === "linux";
  const cores = cpus().length;
  const { governor, turboDisabled } = await readIsolation();
  const hasTaskset = (await tryExec("taskset", ["--version"])) !== null;

  const issues: string[] = [];
  if (!linux) {
    issues.push("not Linux — governor/turbo/core-pinning unavailable; numbers are indicative only");
  }
  if (linux && governor !== "performance") {
    issues.push(`CPU governor is ${governor ?? "unknown"}, not "performance"`);
  }
  if (linux && turboDisabled !== true) {
    issues.push("turbo/boost is not confirmed disabled (clock drift adds noise)");
  }
  if (!hasTaskset) {
    issues.push("taskset not found — cannot pin server/generator to disjoint cores");
  }
  if (cores < 4) {
    issues.push(`only ${cores} cores — need ≥4 for separate server + generator core sets`);
  }

  return { linux, cores, governor, turboDisabled, hasTaskset, issues };
}

/** Inputs `collectEnv` needs from the run that just completed. */
export interface CollectEnvOptions {
  readonly recordedAt: string;
  readonly generator: string;
  readonly appsDir: string;
  /** The frameworks that ran; `pkg: null` → version is the git SHA (the Lesto variants). */
  readonly frameworks: ReadonlyArray<{ name: string; dir: string; pkg: string | null }>;
  readonly serverCpus: string | null;
  readonly genCpus: string | null;
}

/**
 * Gather the live environment after a run. Impure (reads `os`, shells `git`/`node`,
 * reads `/sys` and resolved `package.json`s); every probe degrades to null/unknown
 * rather than throwing, so a missing tool weakens the provenance block but never
 * fails the run.
 */
export async function collectEnv(opts: CollectEnvOptions): Promise<BenchEnv> {
  const cpu = cpus();
  const gitSha = await tryExec("git", ["rev-parse", "--short", "HEAD"]);
  const benchmarksDir = join(opts.appsDir, "..");

  const frameworkVersions: Record<string, string> = {};
  for (const fw of opts.frameworks) {
    const version =
      fw.pkg === null
        ? (gitSha ?? "unknown")
        : ((await pkgVersion(join(opts.appsDir, fw.dir), fw.pkg)) ?? "unknown");
    frameworkVersions[fw.name] = version;
  }

  const isolation = await readIsolation();

  return {
    recordedAt: opts.recordedAt,
    gitSha,
    cpuModel: cpu[0]?.model.trim() ?? "unknown",
    cpuCores: cpu.length,
    memGiB: totalmem() / 1024 ** 3,
    os: `${platform()} ${release()} ${arch()}`,
    bunVersion: process.versions.bun ?? null,
    nodeVersion: await tryExec("node", ["--version"]),
    generator: opts.generator,
    generatorVersion: await generatorVersion(opts.generator, benchmarksDir),
    frameworkVersions,
    governor: isolation.governor,
    turboDisabled: isolation.turboDisabled,
    serverCpus: opts.serverCpus,
    genCpus: opts.genCpus,
  };
}
