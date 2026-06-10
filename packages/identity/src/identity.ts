/**
 * The identity service — the assembled, DB-backed auth battery.
 *
 *   const identity = createIdentity({
 *     db,
 *     secret: env.KEEL_AUTH_SECRET,
 *     mailer: { sendVerificationEmail, sendPasswordResetEmail },
 *     verificationUrl: (token) => `https://app.com/verify?token=${token}`,
 *     resetUrl:        (token) => `https://app.com/reset?token=${token}`,
 *   });
 *
 *   await identity.register("ada@example.com", "correct horse battery staple");
 *   await identity.verifyEmail(tokenFromEmail);
 *   const { session } = identity.login("ada@example.com", "correct horse battery staple");
 *
 * Built as a closure factory (`createIdentity`) returning an object of plain
 * functions — no `this`, no class to extend, options + secrets + signers
 * captured in lexical scope. The `db` handle is *explicit*: identity never
 * reaches for a global, and tests pass their own scoped handle.
 *
 * Composes `@keel/auth` (hashing, sessions, signed tokens) + `@keel/db` (the
 * `users` schema, queries, and DDL) + an injected mailer interface (so a
 * test can capture the outgoing link without booting `@keel/mail`).
 *
 * Edge cases worth flagging up front, because they shape the whole API:
 *
 *   - **Enumeration**. `register` and `requestPasswordReset` deliberately
 *     succeed-shaped on conflict or unknown email; both run a dummy hashing
 *     operation on the failure path so the response time leaks nothing.
 *     `login` distinguishes `IDENTITY_INVALID_CREDENTIALS` from
 *     `IDENTITY_EMAIL_NOT_VERIFIED`, mirroring better-auth's UX-over-leak
 *     trade — call it out, do not paper over it.
 *   - **Single-use reset**. The reset token is signed with a secret that
 *     mixes in the user's current password hash, so the moment the password
 *     changes the token is dead — no replay, no double-reset, even though
 *     the token itself is stateless. See {@link tokens}.
 *   - **Verification replay**. Verification tokens are *not* user-bound
 *     this way: replay is harmless because `verifyEmail` is idempotent and
 *     has no side effect beyond a single boolean flip.
 *   - **Timing**. `login` always runs one `verifyPassword`, even on an
 *     unknown email, against a precomputed dummy hash — so missing-user
 *     and wrong-password paths spend the same scrypt cost.
 */

import { hashPassword, MemorySessionStore, Sessions, verifyPassword } from "@keel/auth";
import type { Clock, Session, SessionStore } from "@keel/auth";
import type { Db } from "@keel/db";

import { IdentityError } from "./errors";
import { packResetToken, resetSigner, unpackResetToken, verifySigner } from "./tokens";

// Namespace import so test code can `vi.spyOn(userRepo, "findUserByEmail")`
// to drive the rare race path (pre-check returns nothing → INSERT races a
// parallel one and hits the UNIQUE constraint). With a plain named import,
// the binding is frozen and the spy never reaches the call site.
import * as userRepo from "./user";
import type { User } from "./user";

/**
 * Email validation, in two layers.
 *
 * The pattern enforces structure (`local@host.tld`); the forbidden-chars
 * guard blocks the characters that have historically smuggled control into
 * either the mail transport (CR/LF header injection, comma-separated
 * delivery — see CVE-2022-31102 in `next-auth`) or the surrounding URL/HTML
 * (`<>"`). Together they keep what we accept narrow enough that a legitimate
 * address still works but the known attack shapes cannot.
 */
const EMAIL_PATTERN = /^[^@]+@[^@]+\.[^@]+$/;
const EMAIL_FORBIDDEN_CHARS = /[\s,;<>"'`\\()[\]{}]/;

/** Length-only password policy, mirroring better-auth: 8–128 chars. */
const MIN_PASSWORD_LENGTH = 8;

/** Caps the input to keep scrypt's CPU cost bounded — no DoS via huge inputs. */
const MAX_PASSWORD_LENGTH = 128;

/** Default session lifetime — 7 days, matching better-auth. */
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Verification token TTL — 24h is the user-friendly default. */
const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Reset token TTL — 1h, narrow because a leaked link compromises the account. */
const DEFAULT_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * A *constant* scrypt hash of a placeholder password.
 *
 * `login` runs `verifyPassword(candidate, DUMMY_HASH)` whenever the supplied
 * email matches no user, so the no-user and wrong-password paths spend the
 * same CPU. Precomputed at module load so the cost of producing it doesn't
 * show up on the first failed login.
 */
const DUMMY_HASH = hashPassword("__keel_identity_timing_decoy__");

const invalidToken = (kind: "verification" | "reset"): IdentityError =>
  new IdentityError("IDENTITY_INVALID_TOKEN", `The ${kind} link is invalid or has expired.`);

const assertValidEmail = (email: string): void => {
  const trimmed = email.trim();

  if (!EMAIL_PATTERN.test(trimmed) || EMAIL_FORBIDDEN_CHARS.test(trimmed)) {
    throw new IdentityError("IDENTITY_INVALID_EMAIL", "Email address is invalid.");
  }
};

const assertValidPassword = (password: string): void => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new IdentityError(
      "IDENTITY_WEAK_PASSWORD",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new IdentityError(
      "IDENTITY_WEAK_PASSWORD",
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
};

/**
 * The outbound-email seam.
 *
 * Identity does *not* import `@keel/mail` directly. A caller that uses it
 * wires a two-line adapter (`mailer.send("identity.verify", { to, url })`);
 * a test provides a record-capturing fake. That keeps Identity decoupled
 * from queue + mail boot order, and makes the verification-email assertion
 * trivial.
 */
export interface IdentityMailer {
  sendVerificationEmail(args: { to: string; url: string; token: string }): void | Promise<void>;
  sendPasswordResetEmail(args: { to: string; url: string; token: string }): void | Promise<void>;
}

export interface IdentityOptions {
  /** The database handle the service queries through. Explicit, never global. */
  readonly db: Db;

  /**
   * The HMAC secret backing verification and reset token signatures.
   *
   * Domain-separated per purpose inside `tokens.ts`. Strength of the tokens
   * equals the strength of this value — generate it once (e.g. `openssl rand
   * -hex 32`) and store it as an env var.
   */
  readonly secret: string;

  /** The mailer Identity hands verification + reset links to. */
  readonly mailer: IdentityMailer;

  /** Build the absolute URL a user clicks to verify their email. */
  readonly verificationUrl: (token: string) => string;

  /** Build the absolute URL a user clicks to set a new password. */
  readonly resetUrl: (token: string) => string;

  /**
   * Block `login` unless the user has clicked the verification link.
   *
   * Defaults to `true` (the ADR-owner decision). Apps that want low-friction
   * sign-up — magic-link-style, demo modes — can opt out.
   */
  readonly requireVerifiedEmail?: boolean;

  /** Session lifetime in ms. Default 7 days. */
  readonly sessionTtlMs?: number;

  /** Verification token lifetime in ms. Default 24h. */
  readonly verificationTtlMs?: number;

  /** Reset token lifetime in ms. Default 1h. */
  readonly resetTtlMs?: number;

  /** Where sessions live. Defaults to an in-memory store (single-process apps). */
  readonly sessionStore?: SessionStore;

  /**
   * Optional hook called on a successful password reset.
   *
   * The reset itself is already single-use (the per-user-hash signing secret
   * dies with the old password), so this hook only matters if the caller
   * wants to *also* kill any pre-reset login sessions — common in
   * compromised-account flows. The `SessionStore` interface has no by-user
   * index, so the caller does this themselves (typically one
   * `DELETE FROM sessions WHERE user_id = ?`).
   */
  readonly revokeUserSessions?: (userId: string) => void | Promise<void>;

  /** Injected clock — tests pass one so TTL is deterministic. */
  readonly clock?: Clock;
}

/**
 * The identity service — an object of functions, all closing over the
 * `IdentityOptions` passed to {@link createIdentity}.
 *
 * Exported as a type (not a class) so callers store and pass the value
 * around without worrying about `this` binding. The type is the API
 * contract; the implementation is the closure that {@link createIdentity}
 * returns.
 */
export interface Identity {
  register(
    email: string,
    password: string,
  ): Promise<{ status: "verification_sent"; user: User | undefined }>;
  verifyEmail(token: string): User;
  login(email: string, password: string): { user: User; session: Session };
  requestPasswordReset(email: string): Promise<{ status: "reset_sent" }>;
  resetPassword(token: string, newPassword: string): Promise<User>;
  logout(token: string | undefined): void;
  currentUser(token: string | undefined): User | undefined;
}

/** Build an {@link Identity} bound to the given options. */
export function createIdentity(options: IdentityOptions): Identity {
  const db = options.db;
  const requireVerifiedEmail = options.requireVerifiedEmail ?? true;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const verificationTtlMs = options.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS;
  const resetTtlMs = options.resetTtlMs ?? DEFAULT_RESET_TTL_MS;

  const verifyTokens = verifySigner(options.secret, options.clock);

  const sessions = new Sessions({
    store: options.sessionStore ?? new MemorySessionStore(),
    ...(options.clock ? { clock: options.clock } : {}),
  });

  return {
    /**
     * Register a new account.
     *
     * On a fresh email: hashes the password, inserts the user, mints a
     * signed verification token, and asks the mailer to send the link. No
     * session is issued — login is gated on verification (when required).
     *
     * On a colliding email: returns the same shape, runs a throwaway
     * `hashPassword` to equalize CPU cost, and sends no email. That denies
     * an attacker the "is this email registered?" probe. The legitimate
     * owner of an already-registered email simply does not receive a new
     * link.
     *
     * The pre-check + insert pair is not atomic; a parallel registration
     * could race past the pre-check. The unique-constraint catch covers
     * that — the racing call sees the same shape with no new user, exactly
     * as if it had lost the pre-check.
     *
     * Throws `IDENTITY_INVALID_EMAIL` or `IDENTITY_WEAK_PASSWORD` for
     * malformed input — those are *attacker-controlled* shapes, not
     * enumeration signals.
     */
    async register(email, password) {
      assertValidEmail(email);
      assertValidPassword(password);

      const normalized = userRepo.normalizeEmail(email);

      if (userRepo.findUserByEmail(db, normalized)) {
        // Burn the same CPU we'd burn on a real insert so the response time
        // doesn't betray the collision. We discard the result.
        hashPassword(password);

        return { status: "verification_sent", user: undefined };
      }

      let user: User;
      try {
        user = userRepo.insertUser(db, {
          email: normalized,
          passwordHash: hashPassword(password),
          emailVerifiedAt: null,
        });
      } catch {
        // A parallel register raced us through the pre-check and hit the
        // UNIQUE constraint. Treat it as the conflict path so we never leak
        // a 500 for an enumeration probe.
        return { status: "verification_sent", user: undefined };
      }

      const token = verifyTokens.issue(String(user.id), verificationTtlMs);

      await options.mailer.sendVerificationEmail({
        to: normalized,
        url: options.verificationUrl(token),
        token,
      });

      return { status: "verification_sent", user };
    },

    /**
     * Confirm a user's email from a signed verification token.
     *
     * Idempotent: a second call on an already-verified user is a no-op
     * success, not an error. Replay is bounded by the token's TTL and
     * acceptable because verification has no side effect beyond flipping
     * the boolean.
     */
    verifyEmail(token) {
      const claim = verifyTokens.verify(token);

      if (claim === undefined) throw invalidToken("verification");

      const user = userRepo.findUserById(db, Number(claim.userId));

      if (!user) throw invalidToken("verification");

      if (!userRepo.isEmailVerified(user)) {
        const now = new Date().toISOString();
        userRepo.markEmailVerified(db, user.id, now);

        return { ...user, emailVerifiedAt: now };
      }

      return user;
    },

    /**
     * Verify credentials and mint a session.
     *
     * Always spends one scrypt operation — on a missing user, we still call
     * `verifyPassword(candidate, DUMMY_HASH)` so missing-email and wrong-
     * password are timing-indistinguishable.
     *
     * `IDENTITY_INVALID_CREDENTIALS` covers both unknown-email and bad-
     * password. `IDENTITY_EMAIL_NOT_VERIFIED` is distinct (better-auth
     * pattern), which leaks the existence of an unverified registered
     * email — that is the intentional UX-over-leak tradeoff and is
     * documented at the module level.
     */
    login(email, password) {
      const normalized = userRepo.normalizeEmail(email);

      const user = userRepo.findUserByEmail(db, normalized);

      if (!user) {
        // Equalize CPU so a missing user costs the same as a wrong password.
        verifyPassword(password, DUMMY_HASH);

        throw new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password.");
      }

      if (!verifyPassword(password, user.passwordHash)) {
        throw new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password.");
      }

      if (requireVerifiedEmail && !userRepo.isEmailVerified(user)) {
        throw new IdentityError("IDENTITY_EMAIL_NOT_VERIFIED", "Email address not verified.");
      }

      const session = sessions.create(String(user.id), sessionTtlMs);

      return { user, session };
    },

    /**
     * Mint and send a password-reset link.
     *
     * Always resolves "success" — even when the email does not exist — so
     * an attacker cannot probe whether an email is registered by watching
     * response shapes or timing. On the unknown-email path we still run one
     * `issue` to equalize CPU, then discard it; no email goes out.
     */
    async requestPasswordReset(email) {
      const normalized = userRepo.normalizeEmail(email);

      const user = userRepo.findUserByEmail(db, normalized);

      if (!user) {
        // Burn equivalent CPU on the unknown path. The result is thrown away.
        resetSigner(options.secret, "missing-user-dummy", options.clock).issue("0", resetTtlMs);

        return { status: "reset_sent" };
      }

      const signed = resetSigner(options.secret, user.passwordHash, options.clock).issue(
        String(user.id),
        resetTtlMs,
      );
      const token = packResetToken(String(user.id), signed);

      await options.mailer.sendPasswordResetEmail({
        to: normalized,
        url: options.resetUrl(token),
        token,
      });

      return { status: "reset_sent" };
    },

    /**
     * Reset the password against a signed reset token.
     *
     * The token is **single-use in effect**: the signing secret incorporates
     * the user's current `passwordHash`, so once the password changes the
     * token's HMAC no longer verifies. A leaked or replayed link cannot
     * reset the password a second time, and cannot undo a legitimate reset.
     *
     * Pre-reset login sessions are not touched here — call the
     * `revokeUserSessions` hook if your deployment also wants those killed.
     */
    async resetPassword(token, newPassword) {
      assertValidPassword(newPassword);

      const unpacked = unpackResetToken(token);

      if (!unpacked) throw invalidToken("reset");

      const user = userRepo.findUserById(db, Number(unpacked.userId));

      if (!user) throw invalidToken("reset");

      const signer = resetSigner(options.secret, user.passwordHash, options.clock);
      const claim = signer.verify(unpacked.signed);

      // Two checks: signature verified (`claim !== undefined`) AND the inner
      // userId matches the outer one (defense-in-depth — even though forging
      // the inner is impossible without the per-user secret, the equality
      // check makes a tampered outer id a hard no).
      if (claim === undefined || claim.userId !== unpacked.userId) {
        throw invalidToken("reset");
      }

      const newHash = hashPassword(newPassword);
      userRepo.setPasswordHash(db, user.id, newHash);

      if (options.revokeUserSessions) {
        await options.revokeUserSessions(String(user.id));
      }

      return { ...user, passwordHash: newHash };
    },

    logout(token) {
      if (token !== undefined) sessions.revoke(token);
    },

    currentUser(token) {
      if (token === undefined) return undefined;

      const session = sessions.verify(token);

      if (session === undefined) return undefined;

      return userRepo.findUserById(db, Number(session.userId));
    },
  };
}
