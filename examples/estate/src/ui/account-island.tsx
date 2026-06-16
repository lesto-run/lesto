/**
 * The "My Account" island — the heart of auth-aware static, as a `.page` island.
 *
 * `defineIsland` wraps the {@link Account} component into a React element you drop
 * straight into a page tree (`<AccountIsland />`): it self-emits its shell, mount
 * script, and — because it binds the `session` source — its parse-time data primer
 * (ADR 0010/0011). On the prerendered, cacheable marketing page (`PageDef.static`)
 * the server paints {@link AccountFallback} and the island carries a `bind`, so the
 * client resolves the live per-user session and rewrites the control — no
 * `fetch`-in-effect, no `doc → js → fetch` waterfall, no baked-in build-time value.
 *
 * It is eager ON PURPOSE — do not "optimize" it into a lazy `hydrate: "visible"`.
 * Account is ~1 KB, above the fold, and always mounts, so deferring it only adds
 * request hops. Split when an island's bytes are HEAVY or its mount CONDITIONAL —
 * neither is true here (the `/listings/:id` MapIsland in Increment B is the
 * deferred case). See ADR 0009.
 */

import { defineIsland } from "@keel/ui";

import { Account, AccountFallback } from "../account";
import { sessionSource } from "../session-source";

export const AccountIsland = defineIsland({
  name: "Account",
  component: Account,
  fallback: AccountFallback,
  // Its `session` prop is resolved from the session source: bound + primed on the
  // static marketing page, inlined at render on a dynamic page. The server binds
  // the loader in controllers.ts (node) and edge.ts (worker) via `.data()`.
  data: { session: sessionSource },
});
