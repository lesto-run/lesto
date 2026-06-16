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
 *   const { session } = await identity.login("ada@example.com", "correct horse battery staple");
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
 *     unknown email, against a constant dummy hash (computed once on first
 *     use) — so missing-user and wrong-password paths spend the same scrypt cost.
 */

import {
  hashPassword,
  MemorySessionStore,
  needsRehash,
  Sessions,
  verifyPassword,
} from "@keel/auth";
import type { Clock, Session, SessionStore } from "@keel/auth";
import type { Db } from "@keel/db";
import type { RateLimiter } from "@keel/ratelimit";

import { assertStrongSecret, IdentityError } from "./errors";
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
 * A *constant* scrypt hash of a placeholder password, computed lazily.
 *
 * `login` runs `verifyPassword(candidate, await dummyHash())` whenever the
 * supplied email matches no user, so the no-user and wrong-password paths spend
 * the same CPU. Computed on first use and memoized as a *promise* (so racing
 * first-callers share one derive) — NOT at module load: `hashPassword` calls
 * `randomBytes`, and a Cloudflare Worker forbids generating random values
 * in global scope (module evaluation), so an eager module-level constant made
 * `@keel/identity` impossible to even *import* in a Worker. Deferring it keeps
 * the package import-safe on the edge; the one-time cost lands on the first
 * failed login, inside a request handler where randomness is allowed.
 *
 * The lazy memoization has one honest seam: the timing-equalization property
 * holds for all but the FIRST failed-unknown-email login per isolate. On a cold
 * cache that first request also computes the decoy hash (an extra `hashPassword`
 * scrypt), so it is slower than a steady-state miss. Once warmed, every
 * subsequent miss spends exactly one scrypt and is indistinguishable from a
 * wrong-password hit — the property the rest of this doc describes.
 */
let dummyHashCache: Promise<string> | undefined;

const dummyHash = (): Promise<string> =>
  (dummyHashCache ??= hashPassword("__keel_identity_timing_decoy__"));

const invalidToken = (kind: "verification" | "reset"): IdentityError =>
  new IdentityError("IDENTITY_INVALID_TOKEN", `The ${kind} link is invalid or has expired.`);

/**
 * A store that can revoke *every* session for one user in a single statement —
 * the `deleteByUserId` affordance `sqlSessionStore` adds over the core three-verb
 * {@link SessionStore} (ADR 0013). Identity feature-detects this so revoke-on-
 * reset is automatic on a SQL store, with no extra wiring, while a bare memory
 * store (which has no `user_id` index) is left untouched.
 */
interface UserRevocableStore extends SessionStore {
  deleteByUserId(userId: string): Promise<number>;
}

/** True iff the store exposes `deleteByUserId` (i.e. it is SQL-backed). */
const canRevokeByUser = (store: SessionStore): store is UserRevocableStore =>
  typeof (store as Partial<UserRevocableStore>).deleteByUserId === "function";

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

/**
 * A coded identity lifecycle event — the observability seam {@link IdentityOptions.onEvent}
 * receives, owned here, consumed by OTLP wiring elsewhere (operability-dx item 3).
 *
 * The `type` is a stable, machine-readable code: logs, traces, and the audit
 * sink branch on it, never on prose. Every variant carries `at` (the emitting
 * clock's wall-time in ms) so a consumer can order events without its own clock.
 *
 * **No secrets travel here.** A payload never carries a raw session/verification/
 * reset token, a password (plain or hashed), or a cleartext email address. The
 * subject is identified by `userId` — the surrogate primary key — which is safe
 * to log and is all a trace needs to correlate a user's events. The `login_failed`
 * variant deliberately omits even a `userId`: at the point it fires we may not
 * have resolved a user (an unknown-email guess looks identical to a wrong
 * password, by design — the enumeration-safe posture `login` keeps everywhere),
 * and attaching one would both leak existence and lie on the unknown-email path.
 */
export type IdentityEvent =
  | { readonly type: "login_succeeded"; readonly userId: string; readonly at: number }
  | { readonly type: "login_failed"; readonly at: number }
  | { readonly type: "password_reset"; readonly userId: string; readonly at: number }
  | { readonly type: "email_verified"; readonly userId: string; readonly at: number }
  | { readonly type: "session_revoked"; readonly userId: string; readonly at: number };

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
   * Per-account login throttle — the **inner, account-keyed** defense.
   *
   * When present, `login` checks this limiter under the key
   * `login:<normalizedEmail>` before it answers, and burns one token on each
   * *failed* attempt; once the bucket is empty it refuses with a coded
   * `IDENTITY_LOGIN_THROTTLED` (a successful login spends nothing, so a real
   * user is never locked out by their own sign-in). Wire it over
   * `sqlRateLimitStore` so the cap is **fleet-correct** — N failures throttle
   * the account across every node, not per process — typically a small bucket
   * (e.g. `capacity: 5, refillPerSecond: 5/900` ≈ 5 attempts per 15 minutes).
   *
   * This is the credential-stuffing defense: it bounds guesses against *one
   * account* no matter how many IPs an attacker spreads them over. The IP-keyed
   * limiter on the `secureStack` (the request-context client IP) is the OUTER
   * layer — it caps a single client's request rate, but a botnet rotating IPs
   * sails through it, which is exactly the gap this account-keyed limiter
   * closes. Keep both; this one is the defense, the IP limiter is the moat.
   *
   * Enumeration-safe: the key is `login:<email>` for *every* email, existing or
   * not, so the throttle reveals nothing about whether an account exists — the
   * same posture `login` keeps elsewhere (one scrypt on every path,
   * `IDENTITY_INVALID_CREDENTIALS` for both unknown-email and wrong-password).
   */
  readonly loginRateLimiter?: RateLimiter;

  /**
   * Optional hook called on a successful password reset, *in addition to* the
   * built-in revoke-on-reset.
   *
   * Revoke-on-reset is now the **default**: when the configured `sessionStore`
   * is SQL-backed (it exposes `deleteByUserId`, per ADR 0013), `resetPassword`
   * already deletes every one of the user's sessions — so a victim resetting
   * their password ends an attacker's stolen session with no extra wiring. This
   * hook is the escape hatch for the cases that default cannot cover: a store
   * with no `deleteByUserId` (a bare {@link MemorySessionStore}, or a custom
   * one), or a *second* tier to invalidate — e.g. an edge `SignedSessions`
   * revocation list (ADR 0013 §8) the SQL `deleteByUserId` cannot reach. It runs
   * on every successful reset, store-backed revocation or not.
   */
  readonly revokeUserSessions?: (userId: string) => void | Promise<void>;

  /** Injected clock — tests pass one so TTL is deterministic. */
  readonly clock?: Clock;

  /**
   * Optional observability hook fired on each identity lifecycle event —
   * `login_succeeded` / `login_failed` / `password_reset` / `email_verified` /
   * `session_revoked` (see {@link IdentityEvent}).
   *
   * Purely observational: it shapes nothing. The event's outcome (the session,
   * the thrown error) is identical whether or not a hook is wired, so emitting is
   * safe on every path. Wire it to a tracer/audit sink (the dogfood: estate
   * forwards these to OTLP). Payloads carry only a `userId` and a timestamp — no
   * tokens, no passwords, no cleartext emails — so a sink can log them freely.
   *
   * A returned promise is awaited so a sink that flushes asynchronously is not
   * dropped mid-write; a synchronous hook (the common case) adds no latency.
   */
  readonly onEvent?: (event: IdentityEvent) => void | Promise<void>;
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
  verifyEmail(token: string): Promise<User>;
  login(email: string, password: string): Promise<{ user: User; session: Session }>;
  requestPasswordReset(email: string): Promise<{ status: "reset_sent" }>;
  resetPassword(token: string, newPassword: string): Promise<User>;
  logout(token: string | undefined): Promise<void>;
  currentUser(token: string | undefined): Promise<User | undefined>;
}

/** Build an {@link Identity} bound to the given options. */
export function createIdentity(options: IdentityOptions): Identity {
  // The verification/reset token signatures are only as strong as this secret;
  // refuse a weak one at construction rather than mint forgeable tokens
  // (IDENTITY_WEAK_SECRET).
  assertStrongSecret(options.secret);

  const db = options.db;
  const requireVerifiedEmail = options.requireVerifiedEmail ?? true;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const verificationTtlMs = options.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS;
  const resetTtlMs = options.resetTtlMs ?? DEFAULT_RESET_TTL_MS;

  const verifyTokens = verifySigner(options.secret, options.clock);

  const sessionStore = options.sessionStore ?? new MemorySessionStore();

  const sessions = new Sessions({
    store: sessionStore,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  // The event timestamp comes from the same injected clock the rest of the
  // service uses (default `Date.now`), so a test stepping the clock sees
  // deterministic `at` values and the event line is correlatable with the
  // session/token TTLs it sits next to.
  const eventClock = options.clock ?? Date.now;

  // Emit a lifecycle event to the optional sink. Fire-and-forget in spirit —
  // never throws into the caller's path (a broken sink must not break auth) — but
  // awaited so an async sink that flushes a span is not dropped mid-write. With no
  // hook wired this is a single comparison and a return.
  const emit = async (event: IdentityEvent): Promise<void> => {
    if (options.onEvent === undefined) return;

    await options.onEvent(event);
  };

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

      if (await userRepo.findUserByEmail(db, normalized)) {
        // Burn the same CPU we'd burn on a real insert so the response time
        // doesn't betray the collision. We discard the result.
        await hashPassword(password);

        return { status: "verification_sent", user: undefined };
      }

      let user: User;
      try {
        user = await userRepo.insertUser(db, {
          email: normalized,
          passwordHash: await hashPassword(password),
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
    async verifyEmail(token) {
      const claim = verifyTokens.verify(token);

      if (claim === undefined) throw invalidToken("verification");

      const user = await userRepo.findUserById(db, Number(claim.userId));

      if (!user) throw invalidToken("verification");

      if (!userRepo.isEmailVerified(user)) {
        const now = new Date().toISOString();
        await userRepo.markEmailVerified(db, user.id, now);

        // Emit on the real transition only — a second (idempotent) verify is a
        // no-op and must not re-announce an event that already happened.
        await emit({ type: "email_verified", userId: String(user.id), at: eventClock() });

        return { ...user, emailVerifiedAt: now };
      }

      return user;
    },

    /**
     * Verify credentials and mint a session.
     *
     * Always spends one scrypt operation — on a missing user, we still call
     * `verifyPassword(candidate, await dummyHash())` so missing-email and
     * wrong-password are timing-indistinguishable.
     *
     * `IDENTITY_INVALID_CREDENTIALS` covers both unknown-email and bad-
     * password. `IDENTITY_EMAIL_NOT_VERIFIED` is distinct (better-auth
     * pattern), which leaks the existence of an unverified registered
     * email — that is the intentional UX-over-leak tradeoff and is
     * documented at the module level.
     *
     * **Per-account throttle.** With a {@link IdentityOptions.loginRateLimiter}
     * wired, each *failed* attempt burns a token from a `login:<email>` bucket;
     * once it empties, `login` refuses with `IDENTITY_LOGIN_THROTTLED` before it
     * touches the DB or scrypt. The bucket is keyed by email regardless of
     * whether the account exists, so it never leaks existence, and a successful
     * login spends nothing — a real user is never throttled by their own
     * sign-in. Over `sqlRateLimitStore` the cap is fleet-correct. See the option.
     *
     * **Rehash-on-login.** After a password verifies, if the stored hash was
     * minted under weaker scrypt parameters than today's default (a legacy or
     * pre-bump hash), we re-hash the just-proven plaintext at the current cost
     * and persist it. The whole user base walks up to the current cost as
     * people sign in — no forced reset. This runs only on the *success* path,
     * so it never adds work an attacker can trigger, and never on the
     * timing-decoy or wrong-password branches.
     */
    async login(email, password) {
      const normalized = userRepo.normalizeEmail(email);

      // Per-account throttle (the inner defense). The key is `login:<email>` for
      // EVERY email — existing or not — so the throttle leaks nothing about
      // whether an account exists. We peek with cost 0 (which never spends), and
      // refuse before touching the DB or scrypt once the bucket is empty.
      const throttleKey = `login:${normalized}`;

      if (options.loginRateLimiter !== undefined) {
        // Cost 0 never spends — it just reports how many tokens remain. An empty
        // bucket means the account is throttled; we then ask the limiter for the
        // real retry hint with a cost-1 check, which *denies* on an empty bucket
        // and so still spends nothing.
        const peek = await options.loginRateLimiter.check(throttleKey, 0);

        if (peek.remaining < 1) {
          const denied = await options.loginRateLimiter.check(throttleKey, 1);

          // A throttled attempt is a failed login. No `userId` — the throttle
          // refuses before resolving a user, and is enumeration-safe by design
          // (it keys on every email, existing or not), so attaching one would leak.
          await emit({ type: "login_failed", at: eventClock() });

          throw new IdentityError(
            "IDENTITY_LOGIN_THROTTLED",
            "Too many failed login attempts. Try again later.",
            { retryAfterMs: denied.retryAfterMs },
          );
        }
      }

      // Burn one token from the per-account bucket on a failed attempt — the
      // penalty that drains it toward the throttle. Spent on BOTH the unknown-
      // email and wrong-password paths, so the two stay indistinguishable; a
      // successful login spends nothing, so a real user is never locked out by
      // their own sign-in.
      const penalize = async (): Promise<void> => {
        if (options.loginRateLimiter !== undefined) {
          await options.loginRateLimiter.check(throttleKey, 1);
        }
      };

      const user = await userRepo.findUserByEmail(db, normalized);

      if (!user) {
        // Equalize CPU so a missing user costs the same as a wrong password.
        await verifyPassword(password, await dummyHash());

        await penalize();

        // A failed login — no `userId`, because there is no user, and because the
        // unknown-email and wrong-password paths must stay indistinguishable.
        await emit({ type: "login_failed", at: eventClock() });

        throw new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password.");
      }

      if (!(await verifyPassword(password, user.passwordHash))) {
        await penalize();

        // A failed login. Even though we now hold a `user`, we omit its id to keep
        // this branch byte-identical to the unknown-email one above — a sink must
        // not be able to tell "wrong password for a real account" from "no such
        // account", the same leak the coded error already avoids.
        await emit({ type: "login_failed", at: eventClock() });

        throw new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password.");
      }

      if (requireVerifiedEmail && !userRepo.isEmailVerified(user)) {
        throw new IdentityError("IDENTITY_EMAIL_NOT_VERIFIED", "Email address not verified.");
      }

      // Transparently upgrade a stale hash now that we hold the proven plaintext.
      // Best-effort: a failed re-hash or persist must NEVER deny an otherwise-
      // valid login. On failure the stored hash simply stays at its old (still
      // valid) cost and the upgrade is retried on the next sign-in — swallowing
      // here is strictly safer than blocking auth on a transient write error.
      if (needsRehash(user.passwordHash)) {
        try {
          await userRepo.setPasswordHash(db, user.id, await hashPassword(password));
        } catch {
          // The login succeeded; the cost upgrade can wait for the next login.
        }
      }

      const session = await sessions.create(String(user.id), sessionTtlMs);

      // The credentials proved out and a session exists. The token never travels
      // in the event — only the subject's id, which a trace correlates on.
      await emit({ type: "login_succeeded", userId: String(user.id), at: eventClock() });

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

      const user = await userRepo.findUserByEmail(db, normalized);

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
     * **Revoke-on-reset is the default.** When the session store is SQL-backed
     * (it exposes `deleteByUserId`), every one of the user's live sessions is
     * deleted as part of the reset — so the compromised-account flow (an
     * attacker holding a stolen session, the victim resetting their password)
     * ends the attacker's session. A bare memory store has no `deleteByUserId`
     * and is left untouched; wire {@link IdentityOptions.revokeUserSessions} to
     * cover that case (or to invalidate a second tier, e.g. edge tokens). The
     * optional hook always runs too, after the store-backed revocation.
     */
    async resetPassword(token, newPassword) {
      assertValidPassword(newPassword);

      const unpacked = unpackResetToken(token);

      if (!unpacked) throw invalidToken("reset");

      const user = await userRepo.findUserById(db, Number(unpacked.userId));

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

      const newHash = await hashPassword(newPassword);
      await userRepo.setPasswordHash(db, user.id, newHash);

      const userId = String(user.id);

      // The password changed — the reset is complete. The token (single-use via
      // the password-hash binding) is already dead by now and never travels here.
      await emit({ type: "password_reset", userId, at: eventClock() });

      // Revoke-on-reset by default: a SQL-backed store can drop every session
      // for this user in one statement (ADR 0013), so a victim's reset ends an
      // attacker's stolen session without any caller wiring.
      if (canRevokeByUser(sessionStore)) {
        await sessionStore.deleteByUserId(userId);

        // Announce the revocation only when the store actually performed it — a
        // bare memory store has no `deleteByUserId` and revokes nothing, so it
        // emits nothing here (the `revokeUserSessions` hook, if wired, is the
        // caller's own second tier and is not the framework's to announce).
        await emit({ type: "session_revoked", userId, at: eventClock() });
      }

      // The hook still runs (on every store), for a memory store that cannot
      // revoke by user, or a second tier the SQL delete cannot reach.
      if (options.revokeUserSessions) {
        await options.revokeUserSessions(userId);
      }

      return { ...user, passwordHash: newHash };
    },

    async logout(token) {
      if (token === undefined) return;

      // With a sink wired, resolve the session first so the event can name its
      // subject: `verify` returns the live session (or undefined for an unknown/
      // expired token), and we emit `session_revoked` only when a real session was
      // actually ended — a logout of a stale or bogus token announces nothing. With
      // NO sink wired we skip that extra read entirely: logout stays a single
      // delete, unchanged from before the seam existed.
      const session = options.onEvent !== undefined ? await sessions.verify(token) : undefined;

      await sessions.revoke(token);

      if (session !== undefined) {
        await emit({ type: "session_revoked", userId: session.userId, at: eventClock() });
      }
    },

    async currentUser(token) {
      if (token === undefined) return undefined;

      const session = await sessions.verify(token);

      if (session === undefined) return undefined;

      return await userRepo.findUserById(db, Number(session.userId));
    },
  };
}
