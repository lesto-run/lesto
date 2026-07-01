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
 * `@lesto/cli`/`@lesto/mcp`. This test makes that a TESTED invariant on two fronts:
 *
 *   1. The shipped client asset (`out/marketing/client.js`, the bundle the Worker
 *      serves as a Static Asset) contains none of the dev-MCP/loopback-transport
 *      strings — grepping the real built artifact.
 *   2. The production entry modules (the Worker + its build/serve entrypoints)
 *      import neither `@lesto/cli` nor `@lesto/mcp` — so no dev surface can even be
 *      bundled into the deployed Worker.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProductionSite } from "../src/production";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The dev-MCP/loopback-transport strings that must never appear in a shipped artifact:
 * the three dev tool names, the dev-session token header, the loopback transport entry,
 * the AI-overlay dev endpoint, and the stderr banner the bin logs on boot.
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

/** The dev-tooling packages the production build/deploy must not pull in. */
const FORBIDDEN_IMPORTS = ["@lesto/cli", "@lesto/mcp"] as const;

let outDir: string;
let clientBundle: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "estate-prod-mcp-"));

  // The real deploy assembly: prerender the marketing zone + bundle the island client.
  await buildProductionSite(outDir, PROJECT_ROOT);

  clientBundle = await readFile(join(outDir, "marketing", "client.js"), "utf8");
}, 30_000); // the bun bundle step needs headroom beyond the default timeout

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("the production build contains no dev MCP surface", () => {
  it.each(FORBIDDEN_STRINGS)("the shipped client.js has no %s", (needle) => {
    expect(clientBundle).not.toContain(needle);
  });

  it.each(FORBIDDEN_IMPORTS)("the production entry modules import no %s", async (pkg) => {
    // The Worker (the deployed compute) and the build/serve entrypoints that produce the
    // shipped artifact — none may reach the dev-only control plane.
    const sources = await Promise.all(
      ["worker.ts", "serve.ts", "build.ts", "src/production.ts", "src/edge.ts"].map((file) =>
        readFile(join(PROJECT_ROOT, file), "utf8"),
      ),
    );

    for (const source of sources) {
      expect(source).not.toContain(`from "${pkg}"`);
      expect(source).not.toContain(`from '${pkg}'`);
    }
  });
});
