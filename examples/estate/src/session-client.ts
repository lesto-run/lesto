/**
 * Resolve the signed-in user *on the client*.
 *
 * The static marketing pages are the same bytes for everyone, so who you are is
 * never baked in. The Account island calls this on load: it asks the `/mls` zone
 * — same origin, so the session cookie rides along automatically — who the
 * current user is. No CORS, no token plumbing; just a same-origin fetch.
 *
 * `fetchImpl` is injected so tests drive it without a network.
 */

import type { User } from "./auth";

/** The minimal `fetch` shape this needs — the real `fetch` satisfies it. */
export type FetchLike = (
  input: string,
  init?: { credentials?: "same-origin" | "include" | "omit" },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** The same-origin endpoint the `/mls` app answers with the current user. */
export const SESSION_ENDPOINT = "/mls/api/session";

/** Fetch the current user, or `null` when nobody is signed in. */
export async function resolveSession(fetchImpl: FetchLike = fetch): Promise<User | null> {
  const response = await fetchImpl(SESSION_ENDPOINT, { credentials: "same-origin" });

  if (!response.ok) return null;

  const data = (await response.json()) as { user?: User };

  return data.user ?? null;
}
