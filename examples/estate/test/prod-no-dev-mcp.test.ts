/**
 * The production build carries NO dev MCP surface (ADR 0032 Phase 1, increment 8 · L-cfd434f4).
 *
 * `lesto dev` stands up the dev MCP control plane (see `dev-mcp.dogfood.test.ts`),
 * but the ADR's load-bearing claim is that the plane is **dev-only** — never in a
 * shipped artifact. estate is the gallery gate for that claim: it runs locally WITH
 * the dev surface and deploys WITHOUT it.
 *
 * estate's production path is deliberately bespoke (prerender + the Preact island
 * client, `build.ts` → `src/production.ts`), so it structurally never touches
 * `@lesto/cli`/`@lesto/mcp`. This test pins that on two fronts:
 *
 *   1. **The built client artifact** (`out/marketing/client.js`, the real bundle the
 *      Worker serves as a Static Asset) contains none of the dev-MCP/loopback-transport
 *      strings — a low-probability tripwire that fires if an island ever pulled the dev
 *      surface into the browser bundle.
 *   2. **No production source file imports the dev tooling.** It scans EVERY non-test
 *      `.ts`/`.tsx` under the project (the Worker, the entrypoints, all of `src/` and
 *      `app/`) for an `@lesto/cli` / `@lesto/mcp` import specifier — boundary-matched so
 *      it catches static, dynamic, and subpath (`@lesto/mcp/server`) imports without
 *      false-matching `@lesto/client`. So a dev-MCP import anywhere in the deployed graph
 *      fails the gate, not just in five hand-picked files.
 *
 * This is a SOURCE-import + built-client-artifact gate, not a full analysis of the
 * bundled Worker (which needs `wrangler` — unavailable here); front #2's whole-tree
 * scan is what backs "no dev surface reaches the deploy".
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProductionSite } from "../src/production";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The dev-MCP/loopback-transport strings that must never appear in the shipped client
 * bundle: the three dev tool names, the dev-session token header, the loopback transport
 * entry, the AI-overlay dev endpoint, and the stderr banner the bin logs on boot.
 */
const FORBIDDEN_STRINGS = [
  "get_dev_diagnostics",
  "get_recent_requests",
  "tail_logs",
  "x-lesto-dev-token",
  "startMcpHttpServer",
  "__lesto_dev_ai",
  "MCP control plane",
] as const;

/**
 * A dev-tooling import specifier — `@lesto/cli` or `@lesto/mcp` at a specifier boundary
 * (end-quote, or a `/` for a subpath). The `(?=["'/])` lookahead is what keeps
 * `@lesto/client` (which estate imports heavily) from matching `@lesto/cli`.
 */
const FORBIDDEN_IMPORT = /@lesto\/(?:cli|mcp)(?=["'/])/;

/** Directories under the project that never ship (tests, deps, build output, wrangler state). */
const SKIP_DIRS = new Set(["node_modules", "test", "out", ".wrangler", "var", "dist"]);

/** Recursively collect every `.ts`/`.tsx` source file under `dir`, skipping non-shipping dirs. */
async function collectSources(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectSources(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }

  return acc;
}

let outDir: string;
let clientBundle: string;
let prodSources: readonly { path: string; text: string }[];

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "estate-prod-mcp-"));

  // The real deploy assembly: prerender the marketing zone + bundle the island client.
  await buildProductionSite(outDir, PROJECT_ROOT);

  clientBundle = await readFile(join(outDir, "marketing", "client.js"), "utf8");

  const files = await collectSources(PROJECT_ROOT);
  prodSources = await Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
}, 30_000); // the bun bundle step needs headroom beyond the default timeout

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("the production build contains no dev MCP surface", () => {
  it.each(FORBIDDEN_STRINGS)("the shipped client.js has no %s", (needle) => {
    expect(clientBundle).not.toContain(needle);
  });

  it("no production source file imports @lesto/cli or @lesto/mcp", () => {
    // Sanity: the scan actually found the deployed graph (Worker + entrypoints + src/ + app/),
    // so a green result means "checked everything", not "checked nothing".
    expect(prodSources.length).toBeGreaterThan(15);

    const offenders = prodSources.filter((file) => FORBIDDEN_IMPORT.test(file.text));

    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});
