/**
 * Deploy the Lesto benchmark edge Worker with Alchemy (ADR 0044 Inc2) — the deploy AUTHORITY for
 * `lesto-bench-edge`. `wrangler.jsonc` is retained as the LOCAL-RUNTIME config (`start-edge.mjs`
 * runs `wrangler dev --local` against it, cwd = this dir, no `--config` flag) AND as the single
 * SOURCE OF TRUTH for the worker's name + runtime settings, which this script reads (the drift
 * guard). Alchemy owns the DEPLOY; wrangler.jsonc owns the CONFIG.
 *
 *   bunx alchemy login             # one-time: Alchemy needs its OWN CF creds (not wrangler's)
 *   alchemy run alchemy.run.ts     # READ-ONLY preview — confirm ADOPT (not create) BEFORE deploying
 *   bun alchemy.run.ts             # deploy / adopt the existing lesto-bench-edge worker
 *   bun alchemy.run.ts --destroy   # tear down (never blind against the shared live worker)
 *
 * SAFETY (ADR 0044 Inc2): `lesto-bench-edge` was first deployed with `wrangler`, so Alchemy has NO
 * prior state for it — a blind create would ORPHAN or DUPLICATE the live worker. `adopt: true` makes
 * Alchemy TAKE OVER the existing resource of this exact name. Always `alchemy run` first and confirm
 * it reports adopt/update, never a second create.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";

const here = dirname(fileURLToPath(import.meta.url));

/** Parse the JSONC `wrangler.jsonc` (line/block comments + trailing commas) into a plain object. */
function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    // Block comments.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Line comments — the `[^:]` guard leaves `://` in any URL untouched (our config has none, but be safe).
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    // Trailing commas before a closing brace/bracket.
    .replace(/,(\s*[}\]])/g, "$1");

  return JSON.parse(stripped) as Record<string, unknown>;
}

// The DRIFT GUARD: read name + compat date/flags + observability straight from `wrangler.jsonc`, so
// the deployed worker and the driver's local `workerd` loop are the SAME runtime by construction —
// one source of truth, no possible divergence (the apples-to-apples claim ADR 0044 Inc2 protects).
const wrangler = parseJsonc(readFileSync(join(here, "wrangler.jsonc"), "utf8"));
const name = wrangler.name as string;
const compatibilityDate = wrangler.compatibility_date as string;
const compatibilityFlags = (wrangler.compatibility_flags as string[] | undefined) ?? [];
const observabilityEnabled =
  (wrangler.observability as { enabled?: boolean } | undefined)?.enabled ?? true;

// Shared, DO-backed deploy state (ADR 0044 D5) under the one shared `ALCHEMY_STATE_TOKEN` (D4), so
// CI and a second machine adopt the same resource rather than orphaning it.
const app = await alchemy("lesto-bench", {
  stateStore: (scope) => new CloudflareStateStore(scope),
});

// `name` is the LITERAL existing name (no `${stage}` suffix) because we are ADOPTING the resource
// `wrangler deploy` already created under exactly that name.
const worker = await Worker("bench-edge", {
  name,
  adopt: true,
  entrypoint: "worker.ts",
  compatibilityDate,
  compatibilityFlags,
  observability: { enabled: observabilityEnabled },
  url: true,
});

console.log("bench edge:", worker.url);

await app.finalize();
