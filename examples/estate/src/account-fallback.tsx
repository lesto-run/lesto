/**
 * The Account island's server-rendered shell — its own module ON PURPOSE.
 *
 * The registry imports this fallback statically (the server must render it
 * eagerly, and the client entry needs it in the main bundle) while the live
 * `Account` component is reached only through the registry's lazy
 * `() => import("./account")`. If the fallback lived in `account.tsx`, that one
 * static import would pin the whole module — `Account`, its session client, its
 * effects — into the main bundle, and the dynamic import would split nothing. A
 * bundler splits a module only when it is reached *exclusively* dynamically.
 */

import type { ReactElement } from "react";

/** The signed-out CTA, shown until the island's chunk arrives and mounts. */
export function AccountFallback(): ReactElement {
  return (
    <a className="account account--fallback" href="/mls">
      Sign in
    </a>
  );
}
