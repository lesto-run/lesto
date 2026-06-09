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

/** A signed-in person, as the API and the Account island present them. */
export interface User {
  readonly id: string;
  readonly name: string;
}

/** The demo's users. A real app looks these up in the database. */
const USERS: Record<string, User> = {
  jade: { id: "jade", name: "Jade Mills" },
  guest: { id: "guest", name: "Guest Buyer" },
};

/** The cookie that carries the session token across both zones. */
export const SESSION_COOKIE = "keel_session";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** The process-wide session store. In production this is DB- or Redis-backed. */
const sessions = new Sessions({ store: new MemorySessionStore() });

/** Look up a user by id, or `undefined` if no such demo user exists. */
export function findUser(id: string): User | undefined {
  return USERS[id];
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

/** Serialize a `Set-Cookie` value for the session — HttpOnly, site-wide path. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
}

/** Serialize a `Set-Cookie` that clears the session. */
export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
