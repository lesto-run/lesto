/**
 * The canonical catalogue of dispatchable `lesto` CLI commands — the single
 * authority the agent artifacts list, kept in lockstep with the bin's dispatch.
 *
 * Why a hand-curated constant rather than a derived one: dispatch today is
 * imperative `if (command === …)` branches spread across `bin.ts` and `run.ts`,
 * with no scannable command table to read. And the human `USAGE` text (`run.ts`)
 * is NOT the authority — it omits `mcp` and `openapi`, both fully dispatchable. So
 * this constant is sourced from the ACTUAL dispatch set, and a two-way sync test
 * (`agents-commands.test.ts`) reads `bin.ts` + `run.ts` and asserts neither side
 * drifts: every dispatched token appears here, and every token here is dispatched.
 * Add a command branch to the bin → add it here (the test fails until you do).
 */

import type { CliCommandDescriptor } from "./types";

/**
 * Every command `lesto <command>` dispatches, with a one-line summary. `generate`
 * carries its `g` alias; the rest are single-token. Authored in a rough
 * run-it-most-often order — the scan re-sorts for byte-stable output, so this
 * order is for the reader here, not the artifacts.
 */
export const CLI_COMMANDS: readonly CliCommandDescriptor[] = [
  {
    name: "generate",
    aliases: ["g"],
    summary: "Scaffold a resource (model | migration | island | page)",
  },
  { name: "routes", summary: "List the application's routes" },
  {
    name: "routes:gen",
    summary: "Regenerate the edge route manifest (routes.gen.ts) from app/routes/",
  },
  { name: "migrate", summary: "Run pending migrations and print the applied versions" },
  { name: "serve", summary: "Boot the app over HTTP" },
  { name: "dev", summary: "Run every site live on one origin for local development" },
  { name: "build", summary: "Prerender the static sites to disk" },
  {
    name: "deploy",
    summary: "Build and ship the app (--cloudflare for the one-command edge deploy)",
  },
  { name: "rollback", summary: "Flip the live pointer to a published release" },
  { name: "content:build", summary: "Compile markdown content into the content store" },
  { name: "content:new", summary: "Scaffold a new content entry" },
  { name: "content:delete", summary: "Delete a content entry from the store" },
  { name: "mcp", summary: "Run the MCP control-plane server over stdio" },
  { name: "openapi", summary: "Emit the application's OpenAPI document" },
  { name: "help", summary: "Show the usage help" },
];
