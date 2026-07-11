/**
 * Single-use signed tokens for email verification and password reset.
 *
 * Both build on `SignedSessions` from `@lesto/auth` — same claim shape
 * (`userId`, `expiresAt`), same constant-time verification, same total
 * semantics (an invalid token is `undefined`, never an exception an attacker
 * can probe).
 *
 * Two different signing strategies, chosen by what each token needs:
 *
 *   - **Verification** — a shared, domain-separated secret. Idempotent:
 *     `verifyEmail` no-ops on an already-verified user, so token replay
 *     inside the TTL has no further effect.
 *
 *   - **Reset** — a *per-user* secret that mixes in the user's current
 *     `password_hash`. The moment the password changes, the hash changes,
 *     so every previously-issued reset token for that user becomes
 *     un-verifiable. That gives single-use semantics for free: the same
 *     token cannot reset the password a second time, and a stolen reset
 *     link cannot keep resetting the password after the legitimate owner
 *     resets it back. The catch-22 — "I need the user to derive the
 *     secret, but the user is inside the token I'm trying to verify" — is
 *     resolved by carrying the user id in cleartext outside the signed
 *     envelope (it isn't secret), then enforcing on verify that the
 *     unauthenticated id matches the authenticated `claim.userId`.
 */

import { SignedSessions } from "@lesto/auth";
import type { Clock, SignedClaim } from "@lesto/auth";

/** A `SignedSessions` for the shared verify-email purpose. */
export function verifySigner(masterSecret: string, clock?: Clock): SignedSessions {
  return new SignedSessions({
    secret: `${masterSecret}:verify_email`,
    ...(clock ? { clock } : {}),
  });
}

/**
 * A `SignedSessions` for the short-lived second-factor **login challenge**.
 *
 * When a 2FA-enabled user's password verifies, `login` withholds the session
 * and instead issues one of these tokens — a stateless, HMAC-signed proof that
 * the first factor *already* succeeded, carrying the `userId` inside the signed
 * claim. `completeTotpChallenge` verifies it before checking the TOTP/recovery
 * code, so the second step can never mint a session on its own (a bare `userId`
 * is not enough — the caller must present a challenge this server signed). Kept
 * deliberately simple: no per-user secret like {@link resetSigner}, because the
 * short TTL (minutes) bounds replay and the `userId` is authenticated inside the
 * envelope. Domain-separated from the verify/reset purposes so a token minted
 * for one can never be verified as another.
 */
export function totpChallengeSigner(masterSecret: string, clock?: Clock): SignedSessions {
  return new SignedSessions({
    secret: `${masterSecret}:totp_challenge`,
    ...(clock ? { clock } : {}),
  });
}

/**
 * A `SignedSessions` whose secret is bound to a specific user's password hash.
 *
 * Because the password hash is in the HMAC secret, changing the password
 * invalidates every previously-issued reset token for that user — no extra
 * schema column, no server-side state, no per-token revocation list.
 */
export function resetSigner(
  masterSecret: string,
  passwordHash: string,
  clock?: Clock,
): SignedSessions {
  return new SignedSessions({
    secret: `${masterSecret}:reset_password:${passwordHash}`,
    ...(clock ? { clock } : {}),
  });
}

/** Token framing: `<userId>.<signedToken>`. The cleartext id picks the signer. */
const ID_SEPARATOR = ".";

export function packResetToken(userId: string, signed: string): string {
  return `${userId}${ID_SEPARATOR}${signed}`;
}

/** Pull `{ userId, signed }` out of a reset token, or `undefined` if malformed. */
export function unpackResetToken(token: string): { userId: string; signed: string } | undefined {
  const at = token.indexOf(ID_SEPARATOR);

  // A well-formed reset token has the id, the separator, and a signed body
  // following. Reject anything else as malformed without recording why —
  // verifiers should be total, opaque to the attacker.
  if (at <= 0 || at === token.length - 1) return undefined;

  return { userId: token.slice(0, at), signed: token.slice(at + 1) };
}

export type { SignedClaim };
