/**
 * The framework matrix: one entry per app under test. Adding a framework is one
 * entry here plus an app directory under `../apps/<name>` that satisfies the
 * workload contract in `../workloads.md`.
 *
 * Each entry is pure data — the orchestrator in `run.ts` reads it to install,
 * start, probe, load, and stop each app. `prepare` is the one-time setup (install
 * deps, build); `start` boots the server and must listen on `PORT` (the
 * orchestrator assigns a fresh one per app). Competitor apps are self-contained
 * (their own `package.json`, installed on demand) so the root workspace install
 * stays offline-friendly and no competitor dep is ever published with Lesto.
 */

/** A framework app the harness can benchmark. */
export interface AppDef {
  /** The label in the results table. */
  readonly name: string;
  /** Directory under `benchmarks/apps/`. */
  readonly dir: string;
  /** One-time setup (install + build). Run once before `start`. Empty = nothing to do. */
  readonly prepare: readonly string[][];
  /** The command that boots the server; it MUST honor the `PORT` env var. */
  readonly start: readonly string[];
  /** Extra env for the server process (merged over the inherited env). */
  readonly env?: Readonly<Record<string, string>>;
  /** Whether the app is implemented yet. Unimplemented entries are reported as skipped. */
  readonly status: "ready" | "scaffold";
}

/**
 * `bun` boots Lesto + the Bun-native apps (Elysia) and runs TypeScript directly.
 * Node serves the Node-native apps. CI installs each competitor dir on demand.
 */
export const APPS: readonly AppDef[] = [
  {
    name: "lesto",
    dir: "lesto",
    prepare: [],
    start: ["bun", "run", "server.ts"],
    status: "ready",
  },
  {
    // The fair head-to-head with the bare competitor servers: Lesto with the default
    // secure stack OFF (no per-request rate-limit store op). Compare `lesto` vs
    // `lesto-bare` to read the secure baseline's real cost over a socket.
    name: "lesto-bare",
    dir: "lesto",
    prepare: [],
    start: ["bun", "run", "server.ts"],
    env: { LESTO_BENCH_SECURE: "false" },
    status: "ready",
  },
  {
    name: "hono",
    dir: "hono",
    prepare: [["npm", "install", "--no-audit", "--no-fund"]],
    start: ["node", "server.mjs"],
    status: "ready",
  },
  {
    name: "fastify",
    dir: "fastify",
    prepare: [["npm", "install", "--no-audit", "--no-fund"]],
    start: ["node", "server.mjs"],
    status: "ready",
  },
  {
    name: "express",
    dir: "express",
    prepare: [["npm", "install", "--no-audit", "--no-fund"]],
    start: ["node", "server.mjs"],
    status: "ready",
  },
  {
    name: "elysia",
    dir: "elysia",
    prepare: [["bun", "install"]],
    start: ["bun", "run", "server.ts"],
    status: "ready",
  },
  // Meta-frameworks: scaffolded with build steps; apps tracked as follow-ups (see
  // apps/<name>/README.md). Marked `scaffold` so the orchestrator skips them until
  // their server is implemented, rather than failing the whole run.
  {
    name: "next",
    dir: "next",
    prepare: [
      ["npm", "install", "--no-audit", "--no-fund"],
      ["npm", "run", "build"],
    ],
    start: ["npm", "run", "start"],
    status: "scaffold",
  },
  {
    name: "sveltekit",
    dir: "sveltekit",
    prepare: [
      ["npm", "install", "--no-audit", "--no-fund"],
      ["npm", "run", "build"],
    ],
    start: ["node", "build/index.js"],
    status: "scaffold",
  },
  {
    name: "astro",
    dir: "astro",
    prepare: [
      ["npm", "install", "--no-audit", "--no-fund"],
      ["npm", "run", "build"],
    ],
    start: ["node", "./dist/server/entry.mjs"],
    status: "scaffold",
  },
  {
    name: "remix",
    dir: "remix",
    prepare: [
      ["npm", "install", "--no-audit", "--no-fund"],
      ["npm", "run", "build"],
    ],
    start: ["npm", "run", "start"],
    status: "scaffold",
  },
];

/** The three workloads every app must serve identically. See `../workloads.md`. */
export interface Workload {
  readonly name: string;
  readonly path: string;
}

export const WORKLOADS: readonly Workload[] = [
  { name: "plaintext", path: "/plaintext" },
  { name: "json", path: "/json" },
  { name: "ssr", path: "/ssr" },
  // The realistic catalog page: a non-trivial SSR document re-rendered per request
  // behind a simulated 1–5 ms DB round-trip (no caching). See `../workloads.md`.
  { name: "realistic", path: "/realistic" },
];
