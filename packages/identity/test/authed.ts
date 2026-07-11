/**
 * Narrow a {@link LoginResult} to its authenticated arm, or fail loudly.
 *
 * `login` now returns a discriminated union (a confirmed 2FA factor yields
 * `"totp_required"` with no session), so a test that expects a plain
 * password login to mint a session must first assert it took the
 * `"authenticated"` path. This keeps that assertion in one place instead of
 * hand-narrowing at every call site.
 */

import type { LoginResult } from "../src/index";

export function expectAuthenticated(
  result: LoginResult,
): Extract<LoginResult, { status: "authenticated" }> {
  if (result.status !== "authenticated") {
    throw new Error(`expected an authenticated login, got status "${result.status}"`);
  }

  return result;
}
