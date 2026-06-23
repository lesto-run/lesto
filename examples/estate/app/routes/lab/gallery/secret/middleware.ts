/**
 * A file-route `middleware.ts` guard — registered purely by living at
 * `app/routes/lab/gallery/secret/middleware.ts` (ADR 0023, dx-parity R2).
 *
 * A `middleware.ts` runs BEFORE the nearest page's loader, composed down the layout
 * chain (every `middleware.ts` above the page, outermost first) by the same applier
 * that nests layouts and boundaries — no `.use()` call, no per-page wiring. It is
 * the file-route convention's redirect-before-load + context-augmentation seam, the
 * two table-stakes guard moves this one file demonstrates:
 *
 *   - **redirect before load** — without the `?key=jade` pass, the guard returns a
 *     redirect, so the secret page's `load` and render never run; the visitor lands
 *     back on the gallery index. This is the auth-guard shape (`if (!session)
 *     return c.redirect("/login")`) without a real session store.
 *   - **augment the loader context** — with the key, the guard stashes a value with
 *     `c.set(...)` and returns nothing, so the chain falls through to the page, whose
 *     `load` reads it back with `c.get(...)`. This is how a guard that resolves the
 *     request's user hands it to every page below without re-resolving per page.
 */

import type { Context, RouteMiddleware } from "@lesto/web";

/**
 * Guard the secret listing: demand the `?key=jade` pass, else redirect to the
 * gallery; on success, augment the loader's context with the agent's name.
 */
const middleware: RouteMiddleware<"/lab/gallery/secret"> = (c: Context<"/lab/gallery/secret">) => {
  // Redirect-before-load: no pass → bounce to the gallery index, before any render.
  if (c.query("key") !== "jade") {
    return c.redirect("/lab/gallery");
  }

  // Context augmentation: hand the page's `load` a value via the shared context.
  c.set("agent", "Jade Mills");

  // Fall through (return nothing) so the chain advances to the page's loader.
  return undefined;
};

export default middleware;
