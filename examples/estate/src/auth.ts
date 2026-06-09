/**
 * Server-side auth for the `/mls` zone.
 *
 * The session is owned by the dynamic app (`@keel/auth`), issued as a cookie on
 * the one origin both zones share — so the static marketing pages and `/mls`
 * see the same session. This module mints, reads, and clears that cookie.
 *
 * It is a *demo* sign-in: any known user id signs in. The mechanism — a real
 * `Sessions` store, an HttpOnly cookie, server-side verification — is the part
 * that matters and is exactly what a production app does.
 */

import { MemorySessionStore, Sessions } from "@keel/auth";
import type { Session } from "@keel/auth";
import { generateToken, verifyToken } from "@keel/csrf";

/** A signed-in person, as the API and the Account island present them. */
export interface User {
  readonly id: string;
  readonly name: string;
}

/**
 * The demo's users. A real app looks these up in the database.
 *
 * Held in a `Map`, not a plain object, so a lookup can only ever match a user
 * we put here — never an inherited member like `constructor`/`toString`/
 * `__proto__`. With a plain object, `USERS["constructor"]` returns `Object`'s
 * constructor (truthy), which would let `?as=constructor` mint a "valid"
 * session for a non-user. A `Map` has no such prototype chain on its keys.
 */
const USERS = new Map<string, User>([
  ["jade", { id: "jade", name: "Jade Mills" }],
  ["guest", { id: "guest", name: "Guest Buyer" }],
]);

/**
 * The cookie that carries the session token across both zones.
 *
 * The `__Host-` prefix is browser-enforced: a cookie with this name is only
 * accepted when set with `Secure`, `Path=/`, and no `Domain` — so the cookie
 * cannot be set over plain HTTP or scoped to a subdomain. The name and those
 * attributes therefore travel together; `sessionCookie`/`clearCookie` below
 * honor the contract.
 */
export const SESSION_COOKIE = "__Host-keel_session";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** The process-wide session store. In production this is DB- or Redis-backed. */
const sessions = new Sessions({ store: new MemorySessionStore() });

/** Look up a user by id, or `undefined` if no such demo user exists. */
export function findUser(id: string): User | undefined {
  return USERS.get(id);
}

/** Mint a session for a user and return the token to set as a cookie. */
export function signIn(userId: string): Session {
  return sessions.create(userId, ONE_DAY_MS);
}

/** Resolve a session token to its user, or `undefined` when invalid/expired. */
export function userForToken(token: string | undefined): User | undefined {
  if (token === undefined) return undefined;

  const session = sessions.verify(token);

  return session === undefined ? undefined : findUser(session.userId);
}

/** Revoke a session token (sign out). */
export function signOut(token: string | undefined): void {
  if (token !== undefined) sessions.revoke(token);
}

/** Pull a single cookie's value out of a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");

    if (key === name) return rest.join("=");
  }

  return undefined;
}

/**
 * Serialize a `Set-Cookie` value for the session.
 *
 * `Secure` + `Path=/` + no `Domain` are mandatory for the `__Host-` prefix the
 * cookie name carries; `HttpOnly` keeps it off `document.cookie`; `SameSite=Lax`
 * is the baseline CSRF control (the double-submit token is the explicit one).
 */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Serialize a `Set-Cookie` that clears the session — same attributes, expired. */
export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// CSRF — session-bound double-submit tokens (@keel/csrf).
//
// State-changing POSTs (sign-in, sign-out) carry a CSRF token in a hidden form
// field. We mint it bound to a session id, embed it in the form, and verify it
// on the POST; a forged cross-site POST cannot present a token that verifies.
// SameSite=Lax on the session cookie is the baseline; this token is the
// explicit, in-band control.
// ---------------------------------------------------------------------------

/**
 * The HMAC secret backing CSRF token signatures.
 *
 * Read from `KEEL_CSRF_SECRET` so a real deployment supplies its own. The demo
 * fallback keeps the example runnable out of the box; it is NOT a secret and a
 * production deploy MUST set the env var. The signature is only as strong as
 * this value.
 */
const CSRF_SECRET = process.env["KEEL_CSRF_SECRET"] ?? "estate-demo-csrf-secret";

// The id a CSRF token is bound to when there is no session yet (sign-in). The
// sign-in form is reachable signed-out, so its token cannot bind to a real
// session; binding to a fixed anon id still proves the token was minted by this
// origin (an attacker's page cannot forge the HMAC without the secret).
const ANON_BINDING = "anon";

/** The hidden form field and the POST body key that carry the CSRF token. */
export const CSRF_FIELD = "_csrf";

/** Mint a CSRF token bound to a session token (authenticated flows: sign-out). */
export function csrfTokenForSession(sessionToken: string): string {
  return generateToken(sessionToken, CSRF_SECRET);
}

/** Mint a CSRF token for the signed-out sign-in form. */
export function csrfTokenForAnon(): string {
  return generateToken(ANON_BINDING, CSRF_SECRET);
}

/** Verify a CSRF token minted by {@link csrfTokenForSession}. */
export function verifyCsrfForSession(token: string, sessionToken: string): boolean {
  return verifyToken(token, sessionToken, CSRF_SECRET);
}

/** Verify a CSRF token minted by {@link csrfTokenForAnon}. */
export function verifyCsrfForAnon(token: string): boolean {
  return verifyToken(token, ANON_BINDING, CSRF_SECRET);
}
