/**
 * The identity service — the assembled, DB-backed auth battery.
 *
 *   const identity = createIdentity({
 *     db,
 *     secret: env.LESTO_AUTH_SECRET,
 *     mailer: { sendVerificationEmail, sendPasswordResetEmail },
 *     verificationUrl: (token) => `https://app.com/verify?token=${token}`,
 *     resetUrl:        (token) => `https://app.com/reset?token=${token}`,
 *   });
 *
 *   await identity.register("ada@example.com", "correct horse battery staple");
 *   await identity.verifyEmail(tokenFromEmail);
 *   const result = await identity.login("ada@example.com", "correct horse battery staple");
 *   // `result.status === "authenticated"` carries the session; a confirmed 2FA
 *   // factor yields `"totp_required"` + a challenge for `completeTotpChallenge`.
 *
 * Built as a closure factory (`createIdentity`) returning an object of plain
 * functions — no `this`, no class to extend, options + secrets + signers
 * captured in lexical scope. The `db` handle is *explicit*: identity never
 * reaches for a global, and tests pass their own scoped handle.
 *
 * Composes `@lesto/auth` (hashing, sessions, signed tokens) + `@lesto/db` (the
 * `users` schema, queries, and DDL) + an injected mailer interface (so a
 * test can capture the outgoing link without booting `@lesto/mail`).
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
 *   - **Login enumeration**. Every credential-failure path routes through one
 *     `failLogin` epilogue, so unknown-email, wrong-password, and unverifiable-hash
 *     emit the same userId-less event and — in the DEFAULT posture — return the same
 *     `IDENTITY_INVALID_CREDENTIALS`. The opt-in `onUnverifiableHash: "require_reset"`
 *     deliberately returns a distinct `IDENTITY_PASSWORD_RESET_REQUIRED` (an
 *     acknowledged trade — see {@link IdentityOptions.onUnverifiableHash}).
 *   - **Timing**. `login` spends one KDF derive on every failure path (a decoy verify
 *     against `dummyHash()` where no real verify ran) via the runtime-adaptive hasher.
 *     Costs are equal for a **single-KDF, single-cost corpus** — the steady state. A
 *     migration/legacy-rehash window has a mixed corpus, so a real row's verify cost
 *     can differ from the decoy's *verify* cost: a timing signal that self-drains for
 *     accounts that sign in (rehash-on-login) but persists for the dormant never-login
 *     tail until it is force-reset/expired at cutover, and is bounded by the default
 *     (or a wired) `loginRateLimiter` unless it is explicitly disabled — durably so
 *     only over a SQL-backed limiter (the in-memory default is a per-process floor).
 *     Codes stay identical (default posture). See {@link pbkdf2MigrationHasher} and
 *     docs/guide/edge-password-migration.md.
 */

import {
  describeHashCost,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashPasswordWeb,
  hashRecoveryCodes,
  MemorySessionStore,
  needsRehash,
  needsRehashWeb,
  Sessions,
  totpKeyUri,
  verifyPassword,
  verifyRecoveryCode,
  verifyTotpStep,
} from "@lesto/auth";
import type { Clock, PasswordHashCost, Session, SessionStore } from "@lesto/auth";
import type { Db } from "@lesto/db";
import { hasCode } from "@lesto/errors";
import { isUniqueViolation, MemoryRateLimitStore, RateLimiter } from "@lesto/ratelimit";

import { assertStrongSecret, IdentityError } from "./errors";
import {
  packResetToken,
  resetSigner,
  totpChallengeSigner,
  unpackResetToken,
  verifySigner,
} from "./tokens";
import * as totpRepo from "./totp";

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

/** Caps the input to keep the KDF's CPU cost bounded — no DoS via huge inputs. */
const MAX_PASSWORD_LENGTH = 128;

/** Default session lifetime — 7 days, matching better-auth. */
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Verification token TTL — 24h is the user-friendly default. */
const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Reset token TTL — 1h, narrow because a leaked link compromises the account. */
const DEFAULT_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Second-factor login-challenge TTL — 5 minutes. The window between "password
 * verified" and "TOTP/recovery code entered": long enough for a human to open
 * their authenticator, short enough that a leaked challenge is near-useless (it
 * still requires a live second-factor code to mint anything).
 */
const DEFAULT_TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * The secure-by-default brute-force cap — 5 attempts, refilling over 15 minutes
 * (F8). Applied out of the box to BOTH the login (`login:<email>`) and
 * second-factor (`totp:<userId>`) paths whenever the caller wires no limiter of
 * their own, so credential-stuffing and 2FA code-guessing are bounded by
 * DEFAULT, not opt-in. Mirrors the config the option docs have always suggested
 * (`capacity: 5, refillPerSecond: 5/900`). See {@link defaultRateLimiter}.
 */
const DEFAULT_THROTTLE_CAPACITY = 5;
const DEFAULT_THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Build the secure-by-default per-account throttle: an in-memory token bucket at
 * the {@link DEFAULT_THROTTLE_CAPACITY} / {@link DEFAULT_THROTTLE_WINDOW_MS} cap,
 * used whenever a caller wires neither {@link IdentityOptions.loginRateLimiter}
 * nor {@link IdentityOptions.totpRateLimiter} explicitly (F8: brute-force
 * protection is ON by default, not opt-in).
 *
 * In-memory ON PURPOSE — the secure default MUST NOT require an external store to
 * exist, so it mirrors the default {@link MemorySessionStore}: a per-process
 * floor with zero configuration. That floor is real on a long-lived Node server
 * (the bucket persists across requests in one process), but WEAK on serverless /
 * edge (a fresh isolate resets it) and per-node on a multi-node fleet. For a
 * DURABLE, fleet-wide cap wire a limiter over `sqlRateLimitStore` (the option
 * docs show the shape); pass `false` to opt out deliberately. login and TOTP each
 * get their OWN instance, so the two buckets never interact.
 */
const defaultRateLimiter = (clock: Clock | undefined): RateLimiter =>
  new RateLimiter({
    store: new MemoryRateLimitStore(),
    capacity: DEFAULT_THROTTLE_CAPACITY,
    refillPerSecond: DEFAULT_THROTTLE_CAPACITY / (DEFAULT_THROTTLE_WINDOW_MS / 1000),
    ...(clock ? { clock } : {}),
  });

/**
 * The password-hashing surface Identity leans on — an injectable seam over
 * `@lesto/auth`'s KDF (ADR 0020), bundled so a caller can substitute the whole
 * implementation as one unit.
 *
 * Every method delegates to `@lesto/auth`'s runtime-adaptive facade, which mints a
 * self-describing hash under the KDF the host runtime can bear — memory-hard scrypt
 * on Node, CPU-hard PBKDF2 on the edge, where scrypt's ~128 MiB working set would
 * OOM-crash a Cloudflare Workers isolate (L-7735be80). This seam exists to make the
 * *cost* an injection point, not to fork the algorithm. The production default —
 * {@link productionHasher} — runs full strength (scrypt N=2^17 ~150 ms/derive on
 * Node; OWASP-floor PBKDF2 on the edge), which is right for a real deployment but far
 * too slow to invoke the dozens of times a unit suite does. A test passes a
 * cheap-cost implementation of this same shape so the password / recovery-code paths
 * stay fast without weakening what ships.
 *
 * The default MUST remain the production cost: {@link IdentityOptions.hasher} is
 * optional and falls back to {@link productionHasher}, so a caller that does not
 * wire it gets full-strength, edge-safe hashing with no way to accidentally
 * under-cost it.
 */
export interface PasswordHasher {
  /** Hash a password / recovery code with a fresh salt under the current cost. */
  hashPassword(password: string): Promise<string>;

  /**
   * Verify a candidate against a stored hash in constant time; `false` on a malformed
   * or mismatched hash. May reject with a coded `AuthError` `AUTH_KDF_UNAVAILABLE` when
   * the stored hash names a KDF this runtime cannot run (scrypt on the edge) — `login`
   * catches that and maps it via {@link IdentityOptions.onUnverifiableHash}.
   */
  verifyPassword(password: string, stored: string): Promise<boolean>;

  /** True iff the stored hash was minted below today's cost — the rehash-on-login seam. */
  needsRehash(stored: string): boolean;

  /** Hash a batch of plaintext recovery codes for storage at rest. */
  hashRecoveryCodes(codes: readonly string[]): Promise<string[]>;

  /** Verify a candidate recovery code against one stored hash, in constant time. */
  verifyRecoveryCode(code: string, storedHash: string): Promise<boolean>;
}

/**
 * The production password hasher — the full-cost, runtime-adaptive `@lesto/auth` KDF
 * (scrypt on Node, PBKDF2 on the edge), and the default whenever
 * {@link IdentityOptions.hasher} is not wired. Deployments get this with no
 * configuration; only tests substitute a cheaper cost.
 */
const productionHasher: PasswordHasher = {
  hashPassword,
  verifyPassword,
  needsRehash,
  hashRecoveryCodes,
  verifyRecoveryCode,
};

/**
 * A migration preset for moving an existing password DB from Node to the edge
 * (L-5ecfb54e). Wire it as {@link IdentityOptions.hasher} on the **still-live Node
 * tier** before cutover: `createIdentity({ …, hasher: pbkdf2MigrationHasher })`.
 *
 * It verifies exactly as production does (Node runs scrypt fine, so existing
 * `scrypt$…` rows still authenticate) but MINTS PBKDF2 even on Node and reports any
 * non-PBKDF2 stored hash as due for rehash. So the existing rehash-on-login seam
 * re-mints each user's proven plaintext as edge-safe PBKDF2 on their next sign-in —
 * draining the corpus to PBKDF2 with no forced reset. Whatever tail has not signed
 * in by cutover is handled by a password reset (which also mints PBKDF2). Password
 * hashes are one-way, so this convert-on-login (or reset) is the ONLY way to migrate
 * a hash — there is no offline batch conversion. See the runbook in
 * `docs/guide/edge-password-migration.md`.
 *
 * ⚠️ TIMING CAVEAT (enumeration): this hasher MINTS PBKDF2 but VERIFIES a not-yet-
 * converted row with scrypt, so the login timing-decoy (minted via `hashPassword` →
 * PBKDF2) no longer costs the same as verifying an unconverted scrypt row. During the
 * migration window an attacker can distinguish "real unconverted account" (scrypt-cost
 * response) from "unknown/converted" (PBKDF2-cost) by wall-time, despite identical
 * error codes — worst for legacy N=2^14 rows. This is inherent to a mixed-KDF corpus
 * (a single decoy cannot match every per-row cost). Rehash-on-login drains it for
 * accounts that sign in, but the dormant never-login tail keeps its scrypt row until
 * force-reset/expired — so it does NOT fully self-drain. MUST-DOs: the default
 * in-memory `loginRateLimiter` already bounds this per process, but for a durable,
 * fleet-wide bound during migration wire a SQL-backed `loginRateLimiter` (do NOT
 * disable it with `false`); keep the window short, drain the corpus before cutover
 * (see the runbook), and monitor.
 */
export const pbkdf2MigrationHasher: PasswordHasher = {
  hashPassword: hashPasswordWeb,
  verifyPassword,
  // A scrypt or legacy row is "stale" for migration → the login seam rehashes it to
  // PBKDF2; a PBKDF2 row defers to the real per-cost check. `"pbkdf2$"` is the stable
  // wire prefix `@lesto/auth` mints (see its `PBKDF2_PREFIX`).
  needsRehash: (stored) => (stored.startsWith("pbkdf2$") ? needsRehashWeb(stored) : true),
  hashRecoveryCodes,
  verifyRecoveryCode,
};

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
 * Identity does *not* import `@lesto/mail` directly. A caller that uses it
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
 * The secret-free KDF-cost descriptor {@link IdentityEvent}'s `password_rehashed`
 * carries as `from`/`to` — re-exported from `@lesto/auth`, which owns the wire
 * format. The `describeHashCost` parser lives there too (reusing each backend's own
 * `parseStored`), so this audit view can NEVER drift from what the verifier accepts,
 * and a new backend's arm (argon2id — ADR 0046) is added in one place, not
 * re-spelled here. See `@lesto/auth`'s `./password`.
 */
export type { PasswordHashCost };

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
 * The `password_rehashed` variant carries {@link PasswordHashCost} `from`/`to`
 * descriptors — algorithm + cost params only, never the salt or derived key.
 */
export type IdentityEvent =
  | { readonly type: "login_succeeded"; readonly userId: string; readonly at: number }
  | { readonly type: "login_failed"; readonly at: number }
  | { readonly type: "password_reset"; readonly userId: string; readonly at: number }
  | {
      /**
       * The rehash-on-login seam re-minted a stale hash and PERSISTED it. `from`/`to`
       * describe the old and new KDF cost (secret-free) so a monitor can catch a
       * strength REDUCTION — e.g. `pbkdf2MigrationHasher` walking a 600k row DOWN to
       * the 100k edge ceiling — which is otherwise invisible. Rides an authenticated
       * success path, so it names its subject with `userId`.
       */
      readonly type: "password_rehashed";
      readonly userId: string;
      readonly at: number;
      readonly from: PasswordHashCost;
      readonly to: PasswordHashCost;
    }
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

  /**
   * Second-factor login-challenge lifetime in ms. Default 5 minutes.
   *
   * The lifetime of the signed challenge {@link Identity.login} returns for a
   * 2FA-enabled account, which {@link Identity.completeTotpChallenge} must
   * present (with a valid code) to mint the session.
   */
  readonly totpChallengeTtlMs?: number;

  /** Where sessions live. Defaults to an in-memory store (single-process apps). */
  readonly sessionStore?: SessionStore;

  /**
   * Per-account login throttle — the **inner, account-keyed** defense.
   *
   * **ON by default (F8).** Left unset, `login` uses the in-memory
   * {@link defaultRateLimiter} — 5 attempts / 15 minutes — so brute-force
   * protection ships out of the box rather than as an opt-in an app author can
   * forget. Pass a limiter to override it (typically one over `sqlRateLimitStore`
   * so the cap is **fleet-correct** — N failures throttle the account across
   * every node, not per process — e.g. `capacity: 5, refillPerSecond: 5/900`),
   * or pass `false` to disable the throttle entirely (a deliberate opt-out, e.g.
   * when an outer tier already bounds attempts). ⚠️ The default is IN-MEMORY: a
   * per-process floor that resets on a serverless/edge isolate recycle and does
   * not span a multi-node fleet — wire a SQL-backed limiter for a durable,
   * fleet-wide cap in production (see {@link defaultRateLimiter}).
   *
   * `login` checks the resolved limiter under the key `login:<normalizedEmail>`
   * before it answers, and burns one token on each *failed* attempt; once the
   * bucket is empty it refuses with a coded `IDENTITY_LOGIN_THROTTLED` (a
   * successful login spends nothing, so a real user is never locked out by their
   * own sign-in).
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
   * same posture `login` keeps elsewhere (one KDF derive on every failure path,
   * `IDENTITY_INVALID_CREDENTIALS` for both unknown-email and wrong-password).
   */
  readonly loginRateLimiter?: RateLimiter | false;

  /**
   * Per-account second-factor throttle — the brute-force defense on the TOTP and
   * recovery-code challenge, mirroring {@link loginRateLimiter}.
   *
   * A confirmed factor turns a 6-digit code into the *only* remaining barrier
   * after a stolen password, and a recovery code is a fixed break-glass string;
   * without a cap, an attacker who already holds the password can simply iterate
   * codes — so, like {@link loginRateLimiter}, this is **ON by default (F8)**.
   * Left unset, the second-factor paths use the in-memory {@link defaultRateLimiter}
   * (5 attempts / 15 minutes); pass a limiter to override it (typically over
   * `sqlRateLimitStore` for a fleet-correct cap), or `false` to disable it
   * deliberately. ⚠️ The default is IN-MEMORY — a per-process floor, not durable
   * or fleet-wide; wire a SQL-backed limiter in production (see
   * {@link defaultRateLimiter}).
   *
   * `verifyTotpChallenge`, `verifyRecoveryCode`, and the `completeTotpChallenge`
   * login step all check the resolved limiter under the key `totp:<userId>` and
   * burn one token on each *failed* attempt; once the bucket empties they refuse
   * with a coded `IDENTITY_TOTP_THROTTLED` before touching the secret (a
   * *successful* verify spends nothing, so a legitimate user is never locked out
   * of their own second step).
   */
  readonly totpRateLimiter?: RateLimiter | false;

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

  /**
   * The issuer label shown in the user's authenticator app for an enrolled TOTP
   * factor (ADR 0020) — typically your app/product name. Embedded in the
   * `otpauth://` provisioning URI {@link Identity.enrollTotp} returns. Default
   * `"Lesto"`.
   */
  readonly appName?: string;

  /** Injected clock — tests pass one so TTL is deterministic. */
  readonly clock?: Clock;

  /**
   * The password-hashing implementation (see {@link PasswordHasher}).
   *
   * Defaults to {@link productionHasher} — the full-cost, runtime-adaptive
   * `@lesto/auth` KDF (scrypt on Node, PBKDF2 on the edge) — so a deployment gets
   * full-strength, edge-safe hashing with no configuration. The seam exists for
   * tests, which inject a cheap-cost implementation of the same shape to keep the
   * password / recovery-code paths fast; production callers should leave it unset.
   * Under-costing is opt-in and never the default.
   */
  readonly hasher?: PasswordHasher;

  /**
   * What `login` does when it cannot VERIFY a user's stored hash on this runtime —
   * i.e. a `scrypt$…` hash on the edge, where the derive would OOM the isolate, so
   * `@lesto/auth` refuses with `AUTH_KDF_UNAVAILABLE` before touching the KDF. This
   * is the migrated / hybrid-corpus case (see {@link pbkdf2MigrationHasher} and the
   * `docs/guide/edge-password-migration.md` runbook).
   *
   *   - `"invalid_credentials"` (**default**) — refuse with `IDENTITY_INVALID_CREDENTIALS`,
   *     byte- and timing-identical to a wrong password. **Enumeration-safe**: leaks
   *     nothing about whether the account exists or which KDF minted its hash.
   *     Migrated users recover out-of-band (email them a reset link).
   *   - `"require_reset"` — refuse with the distinct `IDENTITY_PASSWORD_RESET_REQUIRED`
   *     so the app can route the user straight to the reset screen in-band. **This
   *     opens an unauthenticated account-existence oracle** (an attacker learns which
   *     emails are registered-but-legacy without a correct password) — a strict
   *     superset of the {@link IDENTITY_EMAIL_NOT_VERIFIED} leak. Bounded and
   *     self-healing (it shrinks as users reset). Choose it only when the in-band UX
   *     outweighs the leak for your threat model.
   *
   * Either way the fix is a password reset, which re-mints the hash as PBKDF2.
   */
  readonly onUnverifiableHash?: "invalid_credentials" | "require_reset";

  /**
   * Optional observability hook fired on each identity lifecycle event —
   * `login_succeeded` / `login_failed` / `password_reset` / `password_rehashed` /
   * `email_verified` / `session_revoked` (see {@link IdentityEvent}).
   *
   * Purely observational: it shapes nothing. The event's outcome (the session,
   * the thrown error) is identical whether or not a hook is wired, and a sink that
   * throws is caught, so emitting is safe on every path. Wire it to a tracer/audit
   * sink (the dogfood: estate forwards these to OTLP). Payloads carry a `userId`
   * and a timestamp (plus, for `password_rehashed`, the secret-free old/new hash
   * cost) — never tokens, passwords, or cleartext emails — so a sink can log them
   * freely.
   *
   * A returned promise is awaited so a sink that flushes asynchronously is not
   * dropped mid-write; a synchronous hook (the common case) adds no latency.
   */
  readonly onEvent?: (event: IdentityEvent) => void | Promise<void>;
}

/**
 * The outcome of {@link Identity.login} — a **discriminated union**, not a bare
 * `{ user, session }`, precisely so a caller cannot treat "password verified" as
 * "authenticated" (the F2 2FA-bypass class):
 *
 *   - `"authenticated"` — the account has no confirmed second factor (or 2FA is
 *     not in use), so the password alone fully authenticates. A live
 *     {@link Session} is minted and returned; this is the session that gates
 *     every "is this user signed in?" check.
 *   - `"totp_required"` — the password verified **but the account has a confirmed
 *     TOTP factor**, so no session is minted yet. A short-lived, signed
 *     {@link Session}-less `challenge` is returned instead; the caller collects a
 *     TOTP or recovery code and calls {@link Identity.completeTotpChallenge} with
 *     that challenge to obtain the session. Until then there is **no session**, so
 *     any handler that gates on "has a session" is correctly *unsatisfied* — 2FA
 *     is enforced by default, not opt-in.
 *
 * Branch on `status`: the `session` field exists only on the authenticated arm,
 * the `challenge` field only on the second-factor arm, so the type system forces
 * the caller to handle the 2FA path rather than silently reading a session that
 * is not there.
 */
export type LoginResult =
  | { readonly status: "authenticated"; readonly user: User; readonly session: Session }
  | { readonly status: "totp_required"; readonly user: User; readonly challenge: string };

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
  /**
   * Verify credentials and either mint a session or — when the account has a
   * confirmed second factor — withhold it and return a challenge to complete via
   * {@link Identity.completeTotpChallenge}. See {@link LoginResult}.
   *
   * **Requires the `totp_factors` table.** Every call reads the caller's
   * confirmed-factor state (to decide `"authenticated"` vs `"totp_required"`),
   * so the `totp_factors` migration must be installed even for a deployment
   * that never enrolls anyone in 2FA. Install {@link totpMigration} (or the
   * {@link identityMigrations} bundle, which is the recommended "install these"
   * set) alongside {@link usersMigration} — a DB missing that table throws a
   * raw, uncoded driver error ("no such table: totp_factors") the first time a
   * login gets past the password + email-verification checks (those throw their
   * coded errors first), NOT one of the coded credential/verification/throttle
   * `IdentityError`s below.
   *
   * Coded failures on the credential/verification/throttle paths:
   * `IDENTITY_INVALID_CREDENTIALS`, `IDENTITY_EMAIL_NOT_VERIFIED`,
   * `IDENTITY_LOGIN_THROTTLED`, and (when {@link IdentityOptions.onUnverifiableHash}
   * is `"require_reset"`) `IDENTITY_PASSWORD_RESET_REQUIRED`.
   */
  login(email: string, password: string): Promise<LoginResult>;

  /**
   * Complete a `"totp_required"` login (ADR 0020): exchange the signed
   * `challenge` from {@link Identity.login} plus a live second-factor `code` for
   * an authenticated {@link Session}. This is what elevates a 2FA account from
   * "password proven" to "fully signed in" — and it is bound server-side to the
   * first factor: the challenge is an HMAC proof that the password already
   * verified, so a valid code alone (without a challenge this server signed)
   * cannot mint a session.
   *
   * Pass `{ recovery: true }` to spend a single-use recovery code instead of a
   * TOTP code (the break-glass path). Throws `IDENTITY_INVALID_CHALLENGE` for a
   * missing/forged/expired challenge (sign in again), and the same
   * `IDENTITY_INVALID_TOTP` / `IDENTITY_TOTP_THROTTLED` a raw challenge does for a
   * bad code or a drained throttle bucket — all before any session is minted.
   */
  completeTotpChallenge(
    challenge: string,
    code: string,
    options?: { recovery?: boolean },
  ): Promise<{ user: User; session: Session }>;
  requestPasswordReset(email: string): Promise<{ status: "reset_sent" }>;
  resetPassword(token: string, newPassword: string): Promise<User>;
  logout(token: string | undefined): Promise<void>;
  currentUser(token: string | undefined): Promise<User | undefined>;

  /**
   * Begin TOTP enrollment for the signed-in user (ADR 0020, Increment 1).
   *
   * Generates a fresh secret, stores it *unconfirmed*, and returns the secret +
   * the `otpauth://` provisioning URI the app renders as a QR code. The secret is
   * returned **only here** — it is never re-fetchable, matching authenticator-app
   * onboarding. Throws `IDENTITY_NOT_AUTHENTICATED` without a live session, or
   * `IDENTITY_TOTP_ALREADY_ENROLLED` when a confirmed factor already exists.
   */
  enrollTotp(token: string | undefined): Promise<{ secret: string; keyUri: string }>;

  /**
   * Confirm enrollment with the first code from the authenticator, returning the
   * one-time-visible recovery codes. On success: mints + persists fresh
   * KDF-hashed recovery codes FIRST (the plaintext is returned once, never
   * stored), then stamps the factor confirmed LAST — so a crash between the two
   * leaves the factor unconfirmed and re-confirmable rather than stranding a
   * confirmed factor with no recovery codes. Throws `IDENTITY_INVALID_TOTP` on a
   * wrong code (or a replay of an already-accepted step),
   * `IDENTITY_TOTP_NOT_ENROLLED` with no pending factor, or
   * `IDENTITY_TOTP_ALREADY_ENROLLED` if it was already confirmed.
   */
  confirmTotp(token: string | undefined, code: string): Promise<{ recoveryCodes: string[] }>;

  /** True iff the user has a confirmed TOTP factor — the caller's MFA-gate probe. */
  hasTotp(userId: number): Promise<boolean>;

  /**
   * Verify a TOTP challenge for a user (the second step after `login`). Resolves
   * `void` on success; throws `IDENTITY_INVALID_TOTP` for an unknown user, an
   * unconfirmed/absent factor, a wrong code, or a *replay* of an already-accepted
   * code inside its live ±window (RFC 6238 §5.2) — all enumeration-quiet. The
   * per-account {@link IdentityOptions.totpRateLimiter} is ON by default, so a
   * drained `totp:<userId>` bucket refuses with `IDENTITY_TOTP_THROTTLED` before
   * the secret is touched (unless the limiter is disabled with `false`).
   */
  verifyTotpChallenge(userId: number, code: string): Promise<void>;

  /**
   * Spend a single-use recovery code for a user (the break-glass second step).
   * Atomically claims the matched code (a conditional `used_at IS NULL` UPDATE), so
   * a replay — or a concurrent second consumer racing the same code — is refused.
   * Throws `IDENTITY_INVALID_TOTP` for an unknown user / no factor / no matching
   * unused code. The per-account {@link IdentityOptions.totpRateLimiter} is ON by
   * default, so a drained `totp:<userId>` bucket refuses with
   * `IDENTITY_TOTP_THROTTLED` first (unless the limiter is disabled with `false`).
   */
  verifyRecoveryCode(userId: number, code: string): Promise<void>;
}

/** Build an {@link Identity} bound to the given options. */
export function createIdentity(options: IdentityOptions): Identity {
  // The verification/reset token signatures are only as strong as this secret;
  // refuse a weak one at construction rather than mint forgeable tokens
  // (IDENTITY_WEAK_SECRET).
  assertStrongSecret(options.secret);

  const db = options.db;
  const hasher = options.hasher ?? productionHasher;
  const onUnverifiableHash = options.onUnverifiableHash ?? "invalid_credentials";
  const requireVerifiedEmail = options.requireVerifiedEmail ?? true;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const verificationTtlMs = options.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS;
  const resetTtlMs = options.resetTtlMs ?? DEFAULT_RESET_TTL_MS;
  const totpChallengeTtlMs = options.totpChallengeTtlMs ?? DEFAULT_TOTP_CHALLENGE_TTL_MS;

  const appName = options.appName ?? "Lesto";

  const verifyTokens = verifySigner(options.secret, options.clock);
  const challengeTokens = totpChallengeSigner(options.secret, options.clock);

  const sessionStore = options.sessionStore ?? new MemorySessionStore();

  // Brute-force protection is ON BY DEFAULT (F8). An unset limiter resolves to
  // the in-memory `defaultRateLimiter` (a per-process floor — no external store
  // required); an explicit `false` opts out deliberately; a wired limiter is used
  // as-is (e.g. a fleet-correct SQL-backed one). login and TOTP each get their own
  // default instance so the two account-keyed buckets never interact. Every
  // throttle site below reads these resolved handles, never `options.*` — so a
  // `false` opt-out cleanly disables the guard (the `!== undefined` checks skip).
  const resolveLimiter = (limiter: RateLimiter | false | undefined): RateLimiter | undefined =>
    limiter === undefined
      ? defaultRateLimiter(options.clock)
      : limiter === false
        ? undefined
        : limiter;

  const loginRateLimiter = resolveLimiter(options.loginRateLimiter);
  const totpRateLimiter = resolveLimiter(options.totpRateLimiter);

  const sessions = new Sessions({
    store: sessionStore,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  // The event timestamp comes from the same injected clock the rest of the
  // service uses (default `Date.now`), so a test stepping the clock sees
  // deterministic `at` values and the event line is correlatable with the
  // session/token TTLs it sits next to.
  const eventClock = options.clock ?? Date.now;

  // Emit a lifecycle event to the optional sink. Fire-and-forget in spirit — a
  // throwing or rejecting sink is caught here so it can NEVER break auth (the
  // observational contract in `onEvent`'s doc) — but awaited so an async sink that
  // flushes a span is not dropped mid-write. With no hook wired this is a single
  // comparison and a return.
  const emit = async (event: IdentityEvent): Promise<void> => {
    if (options.onEvent === undefined) return;

    try {
      await options.onEvent(event);
    } catch {
      // Purely observational: a broken sink must not deny a login/reset. The event
      // is fire-and-forget for the caller, so its failure is intentionally dropped.
    }
  };

  // Resolve a session token to its user, or refuse — the gate the TOTP
  // enrollment/confirm methods stand behind (they mutate the signed-in user's
  // own factor, so an anonymous caller has no business there).
  const requireUser = async (token: string | undefined): Promise<User> => {
    if (token !== undefined) {
      const session = await sessions.verify(token);

      if (session !== undefined) {
        const user = await userRepo.findUserById(db, Number(session.userId));

        if (user !== undefined) return user;
      }
    }

    throw new IdentityError("IDENTITY_NOT_AUTHENTICATED", "Sign in to manage your authenticator.");
  };

  // Refuse a second-factor attempt once the per-account `totp:<userId>` bucket is
  // drained — the brute-force guard on the TOTP/recovery challenge, mirroring the
  // login throttle's peek-then-deny. Cost-0 peek never spends; the cost-1 retry
  // hint denies on an empty bucket and so also spends nothing. Throttling is ON
  // by default; only an explicit `false` opt-out makes this a no-op return.
  const assertTotpNotThrottled = async (userId: number): Promise<void> => {
    if (totpRateLimiter === undefined) return;

    const key = `totp:${userId}`;
    const peek = await totpRateLimiter.check(key, 0);

    if (peek.remaining < 1) {
      const denied = await totpRateLimiter.check(key, 1);

      throw new IdentityError(
        "IDENTITY_TOTP_THROTTLED",
        "Too many failed verification attempts. Try again later.",
        { retryAfterMs: denied.retryAfterMs },
      );
    }
  };

  // Burn one token from the per-account second-factor bucket on a FAILED attempt —
  // the penalty that drains it toward the throttle. A successful verify never
  // calls this, so a real user is never locked out of their own second step.
  const penalizeTotp = async (userId: number): Promise<void> => {
    if (totpRateLimiter !== undefined) {
      await totpRateLimiter.check(`totp:${userId}`, 1);
    }
  };

  // A decoy hash, minted lazily on first use and memoized as a promise (so racing
  // first-callers share one derive). Deferred — NOT computed at construction — because
  // `hashPassword` calls `randomBytes`, which a Cloudflare Worker forbids in
  // global/module scope; a decoy built eagerly made `@lesto/identity` impossible to
  // even *import* on the edge. The one-time mint lands on the first failed login,
  // inside a request handler where randomness is allowed. It runs through the SAME
  // injected `hasher` as every other path, so an injected cheap-cost hasher keeps the
  // decoy cheap too. `failLogin` awaits this on EVERY failure path (not just the
  // no-user one), so the first-miss mint is amortized uniformly across failure types —
  // a cold isolate's first failure costs one extra mint no matter WHICH failure it is,
  // so the cold-vs-warm gap no longer correlates with account existence (workerd
  // recycles isolates, so a per-existence cold gap would otherwise recur).
  let dummyHashCache: Promise<string> | undefined;
  const dummyHash = (): Promise<string> =>
    (dummyHashCache ??= hasher.hashPassword("__lesto_identity_timing_decoy__"));

  // The coded refusal for a hash `login` could not verify on this runtime (a
  // `scrypt$…` row on the edge). The enumeration-safe default is byte-identical to a
  // wrong password; `"require_reset"` trades that for an in-band reset signal. See
  // {@link IdentityOptions.onUnverifiableHash}.
  const unverifiableHashError = (): IdentityError =>
    onUnverifiableHash === "require_reset"
      ? new IdentityError(
          "IDENTITY_PASSWORD_RESET_REQUIRED",
          "Your password must be reset before you can sign in.",
        )
      : new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password.");

  // Verify a TOTP code for a user, enforcing the per-account throttle + the
  // live-window replay guard, and record the accepted step on success. The shared
  // core behind both the public {@link Identity.verifyTotpChallenge} primitive
  // (which returns void — the app manages its own session) and
  // {@link Identity.completeTotpChallenge} (which mints a session on success).
  const runTotpChallenge = async (userId: number, code: string): Promise<void> => {
    // Refuse before touching the secret once the per-account bucket is drained —
    // the brute-force guard (a 6-digit code is the only barrier after a stolen
    // password). Keyed `totp:<userId>` for every user, factor or not.
    await assertTotpNotThrottled(userId);

    const factor = await totpRepo.findTotpFactor(db, userId);

    // Unknown user, no factor, or an unconfirmed one all collapse to the same
    // coded refusal — a challenge must not reveal which case it hit. This counts
    // as a failed attempt against the throttle bucket.
    if (factor === undefined || !factor.confirmed) {
      await penalizeTotp(userId);

      throw new IdentityError("IDENTITY_INVALID_TOTP", "That code is invalid or expired.");
    }

    const step = verifyTotpStep(factor.secret, code, { clock: eventClock });

    // A non-matching code, OR a replay of a step we have already spent inside its
    // still-live ±window (RFC 6238 §5.2), is a failed attempt — burn a token and
    // refuse, enumeration-quiet.
    if (step === undefined || (factor.lastUsedStep !== null && step <= factor.lastUsedStep)) {
      await penalizeTotp(userId);

      throw new IdentityError("IDENTITY_INVALID_TOTP", "That code is invalid or expired.");
    }

    // Accepted: persist the step so the same code cannot be replayed. A success
    // spends no throttle token — a real user never locks themselves out.
    await totpRepo.recordTotpStep(db, userId, step);
  };

  // Spend a single-use recovery code for a user — the break-glass second step,
  // behind the same throttle. Shared by the public
  // {@link Identity.verifyRecoveryCode} primitive and the `recovery` path of
  // {@link Identity.completeTotpChallenge}.
  const runRecoveryChallenge = async (userId: number, code: string): Promise<void> => {
    // The same per-account brute-force guard the TOTP challenge stands behind —
    // a recovery code is a fixed break-glass string and equally guessable.
    await assertTotpNotThrottled(userId);

    const candidates = await totpRepo.findUnusedRecoveryCodes(db, userId);

    // Check every still-unused code; the first that matches is *atomically*
    // claimed — `markRecoveryCodeUsed` flips the row only while it is still
    // unused and reports whether it won. A concurrent consumer racing the same
    // code loses the claim (0 rows changed) and falls through to the refusal,
    // closing the check-then-mark TOCTOU. No factor / no unused codes / no match
    // all surface the same coded refusal.
    for (const candidate of candidates) {
      let matched: boolean;
      try {
        matched = await hasher.verifyRecoveryCode(code, candidate.codeHash);
      } catch (error) {
        // The KDF is unavailable on this runtime — a `scrypt$…` recovery-code hash
        // (minted on Node) reaching the edge, where the derive would OOM
        // (`AUTH_KDF_UNAVAILABLE`). All of a user's codes share one algorithm, so
        // none can be checked here; fail closed to the same enumeration-quiet
        // refusal as any miss. Recovery codes are NOT healed by a password reset
        // (that re-mints only the password hash); a migrated user re-enrolls TOTP
        // to get PBKDF2 codes. See docs/guide/edge-password-migration.md.
        //
        // Accepted timing residual: this `break` returns after 0 derives, whereas a
        // genuinely-wrong code loops all candidates — so the KDF-unavailable case is
        // wall-time-distinguishable from a wrong code. Left as-is: it is post-auth
        // (keyed on a resolved `userId`, not an email — not an existence oracle), is
        // still fail-closed + `totpRateLimiter`-bounded, and only reveals migration
        // state; and the loop is already data-dependent (an early match short-circuits).
        if (!hasCode(error, "AUTH_KDF_UNAVAILABLE")) throw error;

        break;
      }

      if (matched) {
        if (await totpRepo.markRecoveryCodeUsed(db, candidate.id)) return;

        // Lost the race: another request spent this code between our read and our
        // conditional UPDATE. Refuse — a recovery code is single-use.
        break;
      }
    }

    await penalizeTotp(userId);

    throw new IdentityError("IDENTITY_INVALID_TOTP", "That recovery code is invalid or used.");
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
        await hasher.hashPassword(password);

        return { status: "verification_sent", user: undefined };
      }

      let user: User;
      try {
        user = await userRepo.insertUser(db, {
          email: normalized,
          passwordHash: await hasher.hashPassword(password),
          emailVerifiedAt: null,
        });
      } catch (error) {
        // This try also wraps `hasher.hashPassword`, so a bare catch-all here
        // swallowed EVERY failure on this path — not just the one it was
        // written for. A parallel register racing us through the pre-check and
        // hitting the UNIQUE constraint is the ONLY case that belongs to the
        // conflict shape (enumeration-safe: no 500 that would betray the
        // collision). Anything else — a hasher outage (the edge PBKDF2 bug that
        // motivated this fix, L-f6fbfce8), a transient DB error — must surface
        // as a real failure, never a fake "verification_sent" masking a silent
        // no-op with no row inserted.
        if (!isUniqueViolation(error)) throw error;

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
     * Always spends one KDF derive on every failure path (the runtime-adaptive
     * hasher) — on a missing user or an unverifiable hash we still verify against
     * `dummyHash()` so all failures are timing-indistinguishable on a single-cost
     * corpus (see the module-level Timing note for the mixed-window caveat).
     *
     * `IDENTITY_INVALID_CREDENTIALS` covers both unknown-email and bad-
     * password. `IDENTITY_EMAIL_NOT_VERIFIED` is distinct (better-auth
     * pattern), which leaks the existence of an unverified registered
     * email — that is the intentional UX-over-leak tradeoff and is
     * documented at the module level.
     *
     * **Per-account throttle (ON by default).** {@link IdentityOptions.loginRateLimiter}
     * defaults to an in-memory limiter, so each *failed* attempt burns a token from
     * a `login:<email>` bucket out of the box; once it empties, `login` refuses with
     * `IDENTITY_LOGIN_THROTTLED` before it touches the DB or the KDF. The bucket is
     * keyed by email regardless of whether the account exists, so it never leaks
     * existence, and a successful login spends nothing — a real user is never
     * throttled by their own sign-in. Override it with a `sqlRateLimitStore`-backed
     * limiter for a durable, fleet-correct cap, or pass `false` to disable it. See
     * the option.
     *
     * **Rehash-on-login.** After a password verifies, if the stored hash was
     * minted under weaker KDF parameters than today's default (a legacy or
     * pre-bump hash, either algorithm), we re-hash the just-proven plaintext at the current cost
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
      // refuse before touching the DB or the KDF once the bucket is empty.
      const throttleKey = `login:${normalized}`;

      if (loginRateLimiter !== undefined) {
        // Cost 0 never spends — it just reports how many tokens remain. An empty
        // bucket means the account is throttled; we then ask the limiter for the
        // real retry hint with a cost-1 check, which *denies* on an empty bucket
        // and so still spends nothing.
        const peek = await loginRateLimiter.check(throttleKey, 0);

        if (peek.remaining < 1) {
          const denied = await loginRateLimiter.check(throttleKey, 1);

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
        if (loginRateLimiter !== undefined) {
          await loginRateLimiter.check(throttleKey, 1);
        }
      };

      // The single epilogue for every POST-LOOKUP credential failure — unknown email,
      // wrong password, and an unverifiable stored hash. Routing all three through one
      // closure makes "every failure path is timing- and shape-identical" structural,
      // not three hand-synced copies a future edit could drift apart.
      //
      // It ALWAYS awaits `dummyHash()` — even on the wrong-password path, which already
      // spent a real verify — so the one-time-per-isolate decoy MINT is amortized on the
      // FIRST failure of ANY kind. Without that, a cold isolate's first unknown-email
      // (mint + verify) would out-cost its first wrong-password (verify only), and
      // workerd recycles isolates, so that gap would recur and leak account existence.
      // `spendDecoy` then adds the decoy VERIFY only where a real one did NOT run
      // (unknown-email, unverifiable-hash), so in steady state every failure spends
      // exactly one KDF derive. NOT used by the pre-lookup throttle short-circuit
      // (deliberately cheap) nor the email-not-verified refusal (a distinct code, not a
      // credential guess). The `userId` is never attached — a sink must not tell "wrong
      // password for a real account" from "no such account".
      //
      // Timing caveat (documented, not fixed here): this equalizes a SINGLE-KDF,
      // single-cost corpus (the steady state). During a migration/legacy-rehash window a
      // real row's verify cost can differ from the decoy's verify cost — a signal that
      // self-drains (rehash-on-login) for accounts that sign in but persists for the
      // dormant never-login tail, and is bounded by the default (or a wired)
      // `loginRateLimiter` unless it is disabled — durably so only over a SQL-backed
      // one. See {@link pbkdf2MigrationHasher} and docs/guide/edge-password-migration.md.
      const failLogin = async (spendDecoy: boolean, error: IdentityError): Promise<never> => {
        const decoy = await dummyHash();

        if (spendDecoy) await hasher.verifyPassword(password, decoy);

        await penalize();
        await emit({ type: "login_failed", at: eventClock() });

        throw error;
      };

      const user = await userRepo.findUserByEmail(db, normalized);

      if (!user) {
        // No real verify to spend → the epilogue spends a decoy one.
        return await failLogin(
          true,
          new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password."),
        );
      }

      let passwordOk: boolean;
      try {
        passwordOk = await hasher.verifyPassword(password, user.passwordHash);
      } catch (error) {
        // The hasher REFUSED to verify (it did not just return false): the stored
        // hash names a KDF this runtime cannot run — a `scrypt$…` row on the edge,
        // where the derive would OOM the isolate (`AUTH_KDF_UNAVAILABLE`). Matched by
        // the process-global brand (dep-dup-safe), never `instanceof`.
        if (!hasCode(error, "AUTH_KDF_UNAVAILABLE")) throw error;

        // The refuse ran NO derive → spend a decoy one so this stays timing- and
        // shape-identical to a wrong password (the decoy uses the runtime's native KDF
        // via `dummyHash`, so it never itself refuses).
        return await failLogin(true, unverifiableHashError());
      }

      if (!passwordOk) {
        // The real verify was already spent → no decoy verify, but the epilogue still
        // touches `dummyHash()` so the first-failure mint is amortized on this path too.
        return await failLogin(
          false,
          new IdentityError("IDENTITY_INVALID_CREDENTIALS", "Invalid email or password."),
        );
      }

      if (requireVerifiedEmail && !userRepo.isEmailVerified(user)) {
        throw new IdentityError("IDENTITY_EMAIL_NOT_VERIFIED", "Email address not verified.");
      }

      // Transparently upgrade a stale hash now that we hold the proven plaintext.
      // Best-effort: a failed re-hash or persist must NEVER deny an otherwise-
      // valid login. On failure the stored hash simply stays at its old (still
      // valid) cost and the upgrade is retried on the next sign-in — swallowing
      // here is strictly safer than blocking auth on a transient write error.
      if (hasher.needsRehash(user.passwordHash)) {
        const previousHash = user.passwordHash;
        let rehashed: string | undefined;

        try {
          rehashed = await hasher.hashPassword(password);
          await userRepo.setPasswordHash(db, user.id, rehashed);
        } catch {
          // The login succeeded; the cost upgrade can wait for the next login. A
          // throw here (mint or persist) means nothing was written, so leave
          // `rehashed` unset and emit nothing — the event rides a PERSISTED rehash.
          rehashed = undefined;
        }

        // Announce the cost transition ONLY when the rehash actually persisted.
        // Secret-free `from`/`to` let a monitor catch a strength REDUCTION — a
        // `pbkdf2MigrationHasher` on a non-migrating Node tier walks strong rows
        // DOWN to the 100k edge ceiling, and without this signal that ~6× drop is
        // invisible. `emit` isolates sink failures, so this never affects the login.
        if (rehashed !== undefined) {
          await emit({
            type: "password_rehashed",
            userId: String(user.id),
            at: eventClock(),
            from: describeHashCost(previousHash),
            to: describeHashCost(rehashed),
          });
        }
      }

      // Second-factor gate (ADR 0020 / F2). A confirmed TOTP factor makes the
      // password only the FIRST of two factors, so we must NOT mint a full session
      // on it alone — otherwise every "has a session" gate is satisfied
      // password-only and 2FA is bypass-by-default. Instead we withhold the session
      // and hand back a short-lived, signed challenge that proves this first factor
      // succeeded; `completeTotpChallenge` exchanges it (plus a live code) for the
      // session. Until then there is NO session, so a bare password authenticates
      // nothing. An unconfirmed factor is not a second factor yet, so it does not
      // gate — mid-enrollment users still sign in normally.
      const factor = await totpRepo.findTotpFactor(db, user.id);

      if (factor?.confirmed === true) {
        const challenge = challengeTokens.issue(String(user.id), totpChallengeTtlMs);

        // No `login_succeeded` here: the login is not complete until the second
        // factor lands (that event rides `completeTotpChallenge`). Emitting now
        // would over-count and mislead a monitor into reading "signed in".
        return { status: "totp_required", user, challenge };
      }

      const session = await sessions.create(String(user.id), sessionTtlMs);

      // The credentials proved out and a session exists. The token never travels
      // in the event — only the subject's id, which a trace correlates on.
      await emit({ type: "login_succeeded", userId: String(user.id), at: eventClock() });

      return { status: "authenticated", user, session };
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

      const newHash = await hasher.hashPassword(newPassword);
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

    async enrollTotp(token) {
      const user = await requireUser(token);

      // A confirmed factor is final — re-enrolling would silently invalidate the
      // user's working authenticator. An *unconfirmed* one is fine to replace
      // (they abandoned a half-finished setup), so only a confirmed one refuses.
      const existing = await totpRepo.findTotpFactor(db, user.id);

      if (existing?.confirmed === true) {
        throw new IdentityError(
          "IDENTITY_TOTP_ALREADY_ENROLLED",
          "A confirmed authenticator is already enrolled.",
        );
      }

      const secret = generateTotpSecret();
      await totpRepo.upsertUnconfirmedFactor(db, user.id, secret);

      return { secret, keyUri: totpKeyUri({ secret, issuer: appName, account: user.email }) };
    },

    async confirmTotp(token, code) {
      const user = await requireUser(token);

      const factor = await totpRepo.findTotpFactor(db, user.id);

      // Nothing to confirm: the user never called `enrollTotp` (or it was wiped).
      if (factor === undefined) {
        throw new IdentityError(
          "IDENTITY_TOTP_NOT_ENROLLED",
          "Start enrollment before confirming a code.",
        );
      }

      // Confirming twice is a misuse, not a no-op: the recovery codes were already
      // shown once and would be silently rotated. Refuse rather than re-mint.
      if (factor.confirmed) {
        throw new IdentityError(
          "IDENTITY_TOTP_ALREADY_ENROLLED",
          "A confirmed authenticator is already enrolled.",
        );
      }

      // A freshly enrolled, unconfirmed factor has never recorded a step
      // (`upsertUnconfirmedFactor` writes `lastUsedStep: null`), so the only check
      // here is that the code matches — `verifyTotpStep` returns the matched step.
      const step = verifyTotpStep(factor.secret, code, { clock: eventClock });

      if (step === undefined) {
        throw new IdentityError("IDENTITY_INVALID_TOTP", "That code is invalid or expired.");
      }

      // Mint + persist the backup codes FIRST, then stamp the factor confirmed
      // LAST. A crash between the two now leaves the factor *unconfirmed* — so it
      // is re-confirmable and never strands the user with a confirmed factor but no
      // recovery codes (a lockout). The plaintext codes are returned for one-time
      // display; only the KDF hashes are persisted (ADR 0020).
      const recoveryCodes = generateRecoveryCodes();
      await totpRepo.replaceRecoveryCodes(
        db,
        user.id,
        await hasher.hashRecoveryCodes(recoveryCodes),
      );

      // Record the accepted step so this code can never be replayed, then confirm.
      await totpRepo.recordTotpStep(db, user.id, step);
      await totpRepo.confirmFactor(db, user.id);

      return { recoveryCodes };
    },

    async hasTotp(userId) {
      const factor = await totpRepo.findTotpFactor(db, userId);

      return factor?.confirmed === true;
    },

    async verifyTotpChallenge(userId, code) {
      await runTotpChallenge(userId, code);
    },

    async verifyRecoveryCode(userId, code) {
      await runRecoveryChallenge(userId, code);
    },

    async completeTotpChallenge(challenge, code, completeOptions) {
      // The challenge is the server-side binding to the first factor: only a
      // token this server signed inside `login` (after the password verified)
      // will verify here, so a valid TOTP/recovery code on its own — without a
      // proven password — cannot mint a session. A missing/forged/expired
      // challenge is refused before the code is even looked at.
      const claim = challengeTokens.verify(challenge);

      if (claim === undefined) {
        throw new IdentityError(
          "IDENTITY_INVALID_CHALLENGE",
          "The sign-in challenge is invalid or has expired. Sign in again.",
        );
      }

      const userId = Number(claim.userId);

      // Verify the second factor (throttle + replay guard live inside these,
      // exactly as for the raw primitives). A failure throws before any session
      // is minted — the account stays gated on the second factor.
      if (completeOptions?.recovery === true) {
        await runRecoveryChallenge(userId, code);
      } else {
        await runTotpChallenge(userId, code);
      }

      // The code proved out. Resolve the subject the challenge named — a user
      // deleted between `login` and here leaves the challenge naming no one, so we
      // refuse rather than mint a session for a ghost.
      const user = await userRepo.findUserById(db, userId);

      if (user === undefined) {
        throw new IdentityError(
          "IDENTITY_INVALID_CHALLENGE",
          "The sign-in challenge is invalid or has expired. Sign in again.",
        );
      }

      // Both factors are now proven — mint the authenticated session and announce
      // the (now complete) login. This is the event that means "signed in".
      const session = await sessions.create(String(user.id), sessionTtlMs);

      await emit({ type: "login_succeeded", userId: String(user.id), at: eventClock() });

      return { user, session };
    },
  };
}
