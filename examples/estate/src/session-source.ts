/**
 * The session data source (ADR 0010) — the shared token between server and
 * client for "who is signed in".
 *
 * This replaces the old client-side `resolveSession` fetch: the Account island
 * binds its `session` prop to this token, the server binds the implementation
 * (`volo().data(sessionSource, …)` in `controllers.ts` / `edge.ts`), and the
 * framework delivers the value to the island as a prop — via the parse-time
 * primer on the static marketing page (parallel with `client.js`), so there is
 * no `doc → js → fetch` waterfall and no `fetch`-in-effect for the component to
 * carry. The module holds only a name and a type, so importing it into the
 * client bundle drags no server code across the wire.
 */

import { defineDataSource } from "@volo/ui";

/** A signed-in user, as the source resolves it and the Account island receives it. */
export interface SessionUser {
  readonly id: string;
  readonly name: string;
}

/** The current-user source — its value is `null` when nobody is signed in. */
export const sessionSource = defineDataSource<SessionUser | null>("session");
