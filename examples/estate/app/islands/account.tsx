/**
 * The "My Account" island — the heart of auth-aware static, as a canonical
 * `app/islands/` module (ADR 0011 Increment 2: estate's island convergence).
 *
 * One `defineIsland` default-export per file under `app/islands/` is THE
 * convention `@keel/assets` synthesizes the client entry from (the same shape
 * `examples/blog` proves): the framework reads `module.default.island`, classifies
 * it eager/lazy, and emits the registration — so estate no longer hand-writes a
 * `client.tsx` that lists its islands. The page imports the default and drops it
 * into JSX (`<AccountIsland />`); on the prerendered, cacheable marketing page
 * (`PageDef.static`) the server paints {@link AccountFallback} and the island
 * carries a `bind`, so the client resolves the live per-user session and rewrites
 * the control — no `fetch`-in-effect, no `doc → js → fetch` waterfall.
 *
 * It is eager ON PURPOSE — do not "optimize" it into a lazy `hydrate: "visible"`.
 * Account is ~1 KB, above the fold, and always mounts, so deferring it only adds
 * request hops. Split when an island's bytes are HEAVY or its mount CONDITIONAL
 * (the deferred panel is that case). See ADR 0009.
 */

import { defineIsland } from "@keel/ui";

import { Account, AccountFallback } from "../../src/account";
import { sessionSource } from "../../src/session-source";

export default defineIsland({
  name: "Account",
  component: Account,
  fallback: AccountFallback,
  // Its `session` prop is resolved from the session source: bound + primed on the
  // static marketing page, inlined at render on a dynamic page. The server binds
  // the loader in controllers.ts (node) and edge.ts (worker) via `.data()`.
  data: { session: sessionSource },
});
