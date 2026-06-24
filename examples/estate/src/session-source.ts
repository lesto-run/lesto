/**
 * The session data source (ADR 0010) — the shared token between server and
 * client for "who is signed in".
 *
 * This replaces the old client-side `resolveSession` fetch: the Account island
 * binds its `session` prop to this token, the server binds the implementation
 * (`lesto().data(sessionSource, …)` in `controllers.ts` / `edge.ts`), and the
 * framework delivers the value to the island as a prop — via the parse-time
 * primer on the static marketing page (parallel with `client.js`), so there is
 * no `doc → js → fetch` waterfall and no `fetch`-in-effect for the component to
 * carry. The module holds only a name and a type, so importing it into the
 * client bundle drags no server code across the wire.
 */

import { defineDataSource } from "@lesto/ui";

/** A signed-in user, as the source resolves it and the Account island receives it. */
export interface SessionUser {
  readonly id: string;
  readonly name: string;
}

/**
 * The current-user source — its value is `null` when nobody is signed in.
 *
 * `access: "request-scoped"` is the explicit, secure-by-default opt-out (ADR 0010
 * §5a): the loader (`controllers.ts` / `edge.ts`) resolves the user SOLELY from the
 * caller's own cookie, so the auto-exposed `/__lesto/data/session` route serves each
 * caller only their own session and leaks nothing across users — it is safe unguarded.
 * Declaring it here is what lets `.data(sessionSource, …)` register without a guard
 * chain; omitting it would (correctly) throw `WEB_PRIVATE_DATA_UNGUARDED` at boot.
 */
export const sessionSource = defineDataSource<SessionUser | null>("session", {
  access: "request-scoped",
});
