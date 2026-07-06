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

/**
 * Parse the JSONC `wrangler.jsonc` (line/block comments + trailing commas) into a plain object.
 *
 * STRING-AWARE, single pass: comments and trailing commas are only stripped when OUTSIDE a string
 * literal (respecting `\"` escapes). A `//`, `/* *​/`, or `,}` sequence *inside* a value — e.g. a
 * protocol-relative or comment-shaped URL in `vars`, or a literal `,}` in a string — is preserved
 * verbatim. The prior regex-based stripper was NOT string-aware: a `//`-containing URL blew up as
 * `Unterminated string` and an in-string `/* *​/` / `,}` was silently mangled, so the Alchemy deploy
 * (which reads this on EVERY run) and the local `wrangler dev` loop could parse `wrangler.jsonc`
 * differently. No new dependency: `jsonc-parser` is not in the tree and adding it would rewrite the
 * shared lockfile, so the tokenizer is inlined here.
 */
function parseJsonc(text: string): Record<string, unknown> {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  let pendingComma = -1; // index in `out` of a comma that may still turn out to be trailing, else -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    const next = text[i + 1];
    if (ch === '"') {
      inString = true;
      pendingComma = -1;
      out.push(ch);
    } else if (ch === "/" && next === "/") {
      // Line comment — skip to (but not past) the newline so line structure is preserved.
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      i -= 1; // let the loop's `i++` re-land on the newline (or run off EOF)
    } else if (ch === "/" && next === "*") {
      // Block comment — skip through the closing `*​/`.
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 1; // land on the closing `/`; the loop's `i++` then steps past it
    } else if (ch === ",") {
      pendingComma = out.length;
      out.push(ch);
    } else if (ch === "}" || ch === "]") {
      // The next significant token after a comma is a closer → that comma was trailing; drop it.
      if (pendingComma !== -1) {
        out[pendingComma] = "";
        pendingComma = -1;
      }
      out.push(ch);
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out.push(ch); // whitespace does not end a pending-comma run
    } else {
      pendingComma = -1; // a real value/key token followed the comma → it was NOT trailing
      out.push(ch);
    }
  }

  return JSON.parse(out.join("")) as Record<string, unknown>;
}

// The DRIFT GUARD: read name + compat date/flags + observability straight from `wrangler.jsonc`, so
// the deployed worker and the driver's local `workerd` loop are the SAME runtime by construction —
// one source of truth, no possible divergence (the apples-to-apples claim ADR 0044 Inc2 protects).
const wrangler = parseJsonc(readFileSync(join(here, "wrangler.jsonc"), "utf8"));
const name = wrangler.name as string;
// The entrypoint is part of the drift guard too — read `main` from wrangler.jsonc rather than
// hardcode it, so the deployed worker and the local `wrangler dev` loop can never point at
// different modules.
const entrypoint = wrangler.main as string;
const compatibilityDate = wrangler.compatibility_date as string;
const compatibilityFlags = (wrangler.compatibility_flags as string[] | undefined) ?? [];
const observabilityEnabled =
  (wrangler.observability as { enabled?: boolean } | undefined)?.enabled ?? true;

// SAFETY: `lesto-bench-edge` is a LITERAL-named, adopted, SHARED live worker (not stage-suffixed
// like the example resources), so EVERY stage's state adopts the ONE physical worker. A
// `--destroy` from a developer's `$USER` stage would therefore delete the shared production worker.
// Refuse a teardown unless the stage is explicitly `prod` — the only context that legitimately owns
// the shared resource's lifecycle (and the stage CI deploys under).
if (process.argv.includes("--destroy") && (process.env.ALCHEMY_STAGE ?? "") !== "prod") {
  throw new Error(
    "Refusing to --destroy the shared literal-named `lesto-bench-edge` worker from a non-prod stage. " +
      "Set ALCHEMY_STAGE=prod to deliberately tear down the shared resource.",
  );
}

// Shared, DO-backed deploy state (ADR 0044 D5) under the one shared `ALCHEMY_STATE_TOKEN` (D4), so
// CI and a second machine adopt the same resource rather than orphaning it.
const app = await alchemy("lesto-bench", {
  // `ALCHEMY_STATE_FORCE_UPDATE=1` re-keys the shared state worker's STATE_TOKEN binding to the
  // current `ALCHEMY_STATE_TOKEN` — the one-time move a token rotation needs (see
  // docs/runbooks/rotate-alchemy-state-token.md). Unset in normal deploys, so this is inert.
  stateStore: (scope) =>
    new CloudflareStateStore(scope, {
      forceUpdate: process.env.ALCHEMY_STATE_FORCE_UPDATE === "1",
    }),
});

// `name` is the LITERAL existing name (no `${stage}` suffix) because we are ADOPTING the resource
// `wrangler deploy` already created under exactly that name.
const worker = await Worker("bench-edge", {
  name,
  adopt: true,
  entrypoint,
  compatibilityDate,
  compatibilityFlags,
  observability: { enabled: observabilityEnabled },
  url: true,
});

console.log("bench edge:", worker.url);

await app.finalize();
