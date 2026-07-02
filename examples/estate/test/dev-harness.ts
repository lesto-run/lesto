/**
 * Shared harness bits for estate's `lesto dev` dogfood tests.
 *
 * `inertDeps()` — the required-but-unused `CliDeps` fields a `run(["dev"])` harness needs to
 * satisfy the type, none of which the dev path ever reaches — was defined IDENTICALLY in
 * `dev-mcp.dogfood.test.ts` and `ai-overlay.dogfood.test.ts`; it lives here once. Each test keeps
 * its OWN `capturingServe()` on purpose: the dev-MCP test captures the `logRequest` seam, the
 * AI-overlay test captures the served `App` handle — different observations, not duplication.
 */

import type { CliDeps } from "@lesto/cli";

/** The required-but-unused `CliDeps` fields for a `dev` run (never reached off the dev path). */
export function inertDeps(): Omit<CliDeps, "loadApp" | "serve" | "loadSites" | "out"> {
  return {
    buildContent: () => Promise.resolve([]),
    persistEntries: () => Promise.resolve({ persisted: 0 }),
    pruneEntries: () => Promise.resolve({ deleted: 0 }),
    deleteEntry: () => Promise.resolve({ deleted: 0 }),
    createEntry: () => Promise.resolve(),
    sink: () => () => Promise.resolve(),
    uploader: () => ({
      read: () => Promise.resolve(new Uint8Array()),
      put: () => Promise.resolve(),
    }),
    releaseStore: () => ({
      read: () => Promise.resolve(new Uint8Array()),
      put: () => Promise.resolve(),
      setCurrent: () => Promise.resolve(),
      getCurrent: () => Promise.resolve(undefined),
      listReleases: () => Promise.resolve([]),
    }),
    now: () => 0,
    cloudflare: {
      deploy: () => Promise.resolve({ url: undefined }),
      rollback: () => Promise.resolve(),
    },
    checkHealth: () => Promise.resolve(true),
  };
}
