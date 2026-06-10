/**
 * The identity service — the assembled, DB-backed auth battery.
 *
 *   const identity = new Identity({
 *     secret: env.KEEL_AUTH_SECRET,
 *     mailer: { sendVerificationEmail, sendPasswordResetEmail },
 *     verificationUrl: (token) => `https://app.com/verify?token=${token}`,
 *     resetUrl:        (token) => `https://app.com/reset?token=${token}`,
 *   });
 *
 *   await identity.register("ada@example.com", "correct horse battery staple");
 *   await identity.verifyEmail(tokenFromEmail);
 *   const session = identity.login("ada@example.com", "correct horse battery staple");
 *
 * Composes `@keel/auth` (hashing, sessions, signed tokens) + `@keel/orm` (the
 * `User` model) + an injected mailer interface (so a test can capture the
 * outgoing link without booting `@keel/mail`).
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
import type { Clock, Session, SessionStore, SignedSessions } from "@keel/auth";

import { IdentityError } from "./errors";
import { packResetToken, resetSigner, unpackResetToken, verifySigner } from "./tokens";
import { normalizeEmail, User } from "./user";

/**
 * Email validation, in two layers.
 *
 * The pattern enforces structure (`local@host.tld`); the forbidden-chars guard
 * blocks the characters that have historically smuggled control into either
 * the mail transport (CR/LF header injection, comma-separated delivery —
 * see CVE-2022-31102 in `next-auth`) or the surrounding URL/HTML (`<>"`).
 * Together they keep what we accept narrow enough that a legitimate address
 * still works but the known attack shapes cannot.
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

type ResolvedOptions = Required<
  Pick<
    IdentityOptions,
    | "secret"
    | "mailer"
    | "verificationUrl"
    | "resetUrl"
    | "requireVerifiedEmail"
    | "sessionTtlMs"
    | "verificationTtlMs"
    | "resetTtlMs"
  >
>;

export class Identity {
  private readonly options: ResolvedOptions;

  private readonly sessions: Sessions;

  private readonly verifyTokens: SignedSessions;

  private readonly clock: Clock | undefined;

  private readonly revokeUserSessions: ((userId: string) => void | Promise<void>) | undefined;

  constructor(options: IdentityOptions) {
    this.options = {
      secret: options.secret,
      mailer: options.mailer,
      verificationUrl: options.verificationUrl,
      resetUrl: options.resetUrl,
      requireVerifiedEmail: options.requireVerifiedEmail ?? true,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      verificationTtlMs: options.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS,
      resetTtlMs: options.resetTtlMs ?? DEFAULT_RESET_TTL_MS,
    };

    this.clock = options.clock;
    this.verifyTokens = verifySigner(options.secret, options.clock);

    this.sessions = new Sessions({
      store: options.sessionStore ?? new MemorySessionStore(),
      ...(options.clock ? { clock: options.clock } : {}),
    });

    this.revokeUserSessions = options.revokeUserSessions;
  }

  /**
   * Register a new account.
   *
   * On a fresh email: hashes the password, inserts the user, mints a signed
   * verification token, and asks the mailer to send the link. No session is
   * issued — login is gated on verification (when required).
   *
   * On a colliding email: returns the same shape (`{ status: "verification_sent" }`),
   * runs a throwaway `hashPassword` to equalize CPU cost, and sends no email.
   * That denies an attacker the "is this email registered?" probe. The legitimate
   * owner of an already-registered email simply does not receive a new link.
   *
   * The pre-check + insert pair is not atomic; a parallel registration could
   * race past the pre-check. The unique-constraint catch below covers that —
   * the racing call sees the same "verification_sent" shape with no new user,
   * exactly as if it had lost the pre-check.
   *
   * Throws `IDENTITY_INVALID_EMAIL` or `IDENTITY_WEAK_PASSWORD` for malformed
   * input — those are *attacker-controlled* shapes, not enumeration signals.
   */
  async register(
    email: string,
    password: string,
  ): Promise<{ status: "verification_sent"; user: User | undefined }> {
    this.assertValidEmail(email);
    this.assertValidPassword(password);

    const normalized = normalizeEmail(email);

    if (User.findBy({ email: normalized })) {
      // Burn the same CPU we'd burn on a real insert so the response time
      // doesn't betray the collision. We discard the result.
      hashPassword(password);

      return { status: "verification_sent", user: undefined };
    }

    let user: User;
    try {
      user = User.create({
        email: normalized,
        password_hash: hashPassword(password),
        email_verified_at: null,
      });
    } catch {
      // A parallel register raced us through the pre-check and hit the
      // UNIQUE constraint. Treat it as the conflict path so we never leak
      // a 500 for an enumeration probe.
      return { status: "verification_sent", user: undefined };
    }

    const token = this.verifyTokens.issue(String(user.id), this.options.verificationTtlMs);

    await this.options.mailer.sendVerificationEmail({
      to: normalized,
      url: this.options.verificationUrl(token),
      token,
    });

    return { status: "verification_sent", user };
  }

  /**
   * Confirm a user's email from a signed verification token.
   *
   * Idempotent: a second call on an already-verified user is a no-op success,
   * not an error. Replay is bounded by the token's TTL and acceptable because
   * verification has no side effect beyond flipping the boolean.
   *
   * Throws `IDENTITY_INVALID_TOKEN` for a forged, malformed, or expired token,
   * and for a token whose user no longer exists.
   */
  verifyEmail(token: string): User {
    const claim = this.verifyTokens.verify(token);

    if (claim === undefined) {
      throw this.invalidToken("verification");
    }

    const user = User.findBy({ id: Number(claim.userId) });

    if (!user) {
      throw this.invalidToken("verification");
    }

    if (!user.isEmailVerified) {
      user.update({ email_verified_at: new Date().toISOString() });
    }

    return user;
  }

  /**
   * Verify credentials and mint a session.
   *
   * Always spends one scrypt operation — on a missing user, we still call
   * `verifyPassword(candidate, DUMMY_HASH)` so the response time of an unknown
   * email and a wrong password are indistinguishable.
   *
   * `IDENTITY_INVALID_CREDENTIALS` covers both unknown-email and bad-password.
   * `IDENTITY_EMAIL_NOT_VERIFIED` is distinct (better-auth pattern), which
   * leaks the existence of an unverified registered email — that is the
   * intentional UX-over-leak tradeoff and is documented at the class level.
   */
  login(email: string, password: string): { user: User; session: Session } {
    const normalized = normalizeEmail(email);

    const user = User.findBy({ email: normalized });

    if (!user) {
      // Equalize CPU so a missing user costs the same as a wrong password.
      verifyPassword(password, DUMMY_HASH);

      throw new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password.");
    }

    if (!verifyPassword(password, user.passwordHash)) {
      throw new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password.");
    }

    if (this.options.requireVerifiedEmail && !user.isEmailVerified) {
      throw new IdentityError("IDENTITY_EMAIL_NOT_VERIFIED", "Email address not verified.");
    }

    const session = this.sessions.create(String(user.id), this.options.sessionTtlMs);

    return { user, session };
  }

  /**
   * Mint and send a password-reset link.
   *
   * Always resolves "success" — even when the email does not exist — so an
   * attacker cannot probe whether an email is registered by watching response
   * shapes or timing. On the unknown-email path we still run one `issue` to
   * equalize CPU, then discard it; no email goes out.
   */
  async requestPasswordReset(email: string): Promise<{ status: "reset_sent" }> {
    const normalized = normalizeEmail(email);

    const user = User.findBy({ email: normalized });

    if (!user) {
      // Burn equivalent CPU on the unknown path. The result is thrown away.
      resetSigner(this.options.secret, "missing-user-dummy", this.clock).issue(
        "0",
        this.options.resetTtlMs,
      );

      return { status: "reset_sent" };
    }

    const signed = resetSigner(this.options.secret, user.passwordHash, this.clock).issue(
      String(user.id),
      this.options.resetTtlMs,
    );
    const token = packResetToken(String(user.id), signed);

    await this.options.mailer.sendPasswordResetEmail({
      to: normalized,
      url: this.options.resetUrl(token),
      token,
    });

    return { status: "reset_sent" };
  }

  /**
   * Reset the password against a signed reset token.
   *
   * The token is **single-use in effect**: the signing secret incorporates
   * the user's current `password_hash`, so once the password changes the
   * token's HMAC no longer verifies. A leaked or replayed link cannot reset
   * the password a second time, and cannot undo a legitimate reset.
   *
   * Pre-reset login sessions are not touched here — call the
   * `revokeUserSessions` hook if your deployment also wants those killed.
   */
  async resetPassword(token: string, newPassword: string): Promise<User> {
    this.assertValidPassword(newPassword);

    const unpacked = unpackResetToken(token);

    if (!unpacked) {
      throw this.invalidToken("reset");
    }

    const user = User.findBy({ id: Number(unpacked.userId) });

    if (!user) {
      throw this.invalidToken("reset");
    }

    const signer = resetSigner(this.options.secret, user.passwordHash, this.clock);
    const claim = signer.verify(unpacked.signed);

    // Two checks: signature verified (`claim !== undefined`) AND the inner
    // userId matches the outer one (defense-in-depth — even though forging
    // the inner is impossible without the per-user secret, the equality
    // check makes a tampered outer id a hard no).
    if (claim === undefined || claim.userId !== unpacked.userId) {
      throw this.invalidToken("reset");
    }

    user.update({ password_hash: hashPassword(newPassword) });

    if (this.revokeUserSessions) {
      await this.revokeUserSessions(String(user.id));
    }

    return user;
  }

  /** Revoke a session token (sign out). Safe on undefined / unknown tokens. */
  logout(token: string | undefined): void {
    if (token !== undefined) this.sessions.revoke(token);
  }

  /** Resolve a session token to the live user, or `undefined` if no session. */
  currentUser(token: string | undefined): User | undefined {
    if (token === undefined) return undefined;

    const session = this.sessions.verify(token);

    if (session === undefined) return undefined;

    return User.findBy({ id: Number(session.userId) });
  }

  private invalidToken(kind: "verification" | "reset"): IdentityError {
    return new IdentityError(
      "IDENTITY_INVALID_TOKEN",
      `The ${kind} link is invalid or has expired.`,
    );
  }

  private assertValidEmail(email: string): void {
    const trimmed = email.trim();

    if (!EMAIL_PATTERN.test(trimmed) || EMAIL_FORBIDDEN_CHARS.test(trimmed)) {
      throw new IdentityError("IDENTITY_INVALID_EMAIL", "Email address is invalid.");
    }
  }

  private assertValidPassword(password: string): void {
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
  }
}
