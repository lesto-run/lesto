/**
 * The "My Account" island — the heart of auth-aware static, now a pure function
 * of its data (ADR 0010).
 *
 * It ships in a prerendered, cacheable marketing page but renders per-user — and
 * the per-user `session` arrives as a PROP the framework resolved (the
 * `sessionSource` binding in `registry.tsx`), not a `fetch` this component runs.
 * There is no `useEffect`, no loading state, and no `doc → js → fetch` waterfall:
 * the data was primed at HTML-parse time, parallel with the client bundle. The
 * server paints {@link AccountFallback} until the island hydrates with its data.
 */

import type { ReactElement } from "react";

import type { SessionUser } from "./session-source";

/**
 * The Account control — signed-out CTA, or a greeting + a link to the gated
 * Saved page.
 *
 * Props arrive as the engine's open record (the island wire is untyped at this
 * boundary; the `data` binding names the prop, see registry.tsx) — so `session`
 * is read and narrowed here, the same idiom every island component uses. The
 * value itself was resolved by the framework, never fetched by this component.
 */
export function Account(props: Record<string, unknown>): ReactElement {
  const session = (props.session ?? null) as SessionUser | null;

  if (session === null) {
    return (
      <a className="account account--out" href="/mls">
        Sign in
      </a>
    );
  }

  return (
    <span className="account account--in">
      Hi, {session.name} · <a href="/mls/saved">Saved</a>
    </span>
  );
}

/** The server-rendered shell: the signed-out CTA, shown until the island hydrates. */
export function AccountFallback(): ReactElement {
  return (
    <a className="account account--fallback" href="/mls">
      Sign in
    </a>
  );
}
