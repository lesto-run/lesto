/**
 * The "My Account" island — the heart of auth-aware static.
 *
 * It ships in a prerendered, cacheable marketing page, but renders per-user: on
 * the client it resolves the same-origin session and shows either a sign-in link
 * or a greeting + a link to the gated Saved page. The server emits the
 * {@link AccountFallback} shell so a no-JS visitor still sees a sensible
 * signed-out state; the island upgrades it once hydrated.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import { resolveSession } from "./session-client";
import type { User } from "./session-client";

type AccountState =
  | { readonly status: "loading" }
  | { readonly status: "out" }
  | { readonly status: "in"; readonly user: User };

/** The live, client-only Account component the island mounts. */
export function Account(): ReactElement {
  const [state, setState] = useState<AccountState>({ status: "loading" });

  useEffect(() => {
    let active = true;

    const settle = (next: AccountState): void => {
      if (active) setState(next);
    };

    resolveSession()
      .then((user) => settle(user === null ? { status: "out" } : { status: "in", user }))
      .catch(() => settle({ status: "out" }));

    return () => {
      active = false;
    };
  }, []);

  if (state.status === "loading") {
    return <span className="account account--loading">…</span>;
  }

  if (state.status === "in") {
    return (
      <span className="account account--in">
        Hi, {state.user.name} · <a href="/mls/saved">Saved</a>
      </span>
    );
  }

  return (
    <a className="account account--out" href="/mls">
      Sign in
    </a>
  );
}

// The server-rendered AccountFallback shell lives in its own module
// (`account-fallback.tsx`), NOT here: this module must be reached ONLY through
// the registry's lazy `import()` — that exclusivity is what lets the bundler
// split Account (and its session client) into its own chunk. A static import of
// anything in this file would pin it all back into the main bundle.
