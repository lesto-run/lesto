/**
 * The estate's identity layer — `@lesto/identity` over an in-memory SQLite.
 *
 * This replaces the old `?as=<id>` impersonation demo (which had no
 * credential check at all) with the real Lesto auth flow: a sign-in posts an
 * email and a password, `Identity.login` runs scrypt-hashed credential
 * verification, and mints a real session.
 *
 * The "demo personality" is preserved by *seeding two public demo accounts*
 * with known, plainly-advertised credentials. The form pre-fills them so
 * one click still signs you in — but the click now goes through the real
 * registration → verification → login pipeline, and a wrong password is
 * rejected the same way a real deploy would reject it.
 *
 * The DB is `:memory:`: estate is a demo, not a persistent app, so a fresh
 * boot is a clean slate. Switching to a file-backed SQLite is a one-line
 * change if a deployment wants user accounts that survive a restart.
 *
 * Sessions are durable too: this node path dogfoods `sqlSessionStore`, so the
 * session rows live in the same SQLite handle as the users. In the `:memory:`
 * demo that resets on restart along with everything else — but the *wiring*
 * (install schema → store → identity) is exactly what a production app copies,
 * and a file-backed SQLite or Postgres makes both users and sessions durable for
 * real. The edge path (`edge.ts`, `SignedSessions`) is a separate, stateless
 * tier and is deliberately untouched (ADR 0013 §8).
 */

import { hashPassword, installSessionSchema, sqlSessionStore } from "@lesto/auth";
import { createDb } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { installRateLimitSchema, RateLimiter, sqlRateLimitStore } from "@lesto/ratelimit";
import { openSqlite } from "@lesto/runtime";

import { createIdentity, insertUser, totpMigration, usersMigration } from "@lesto/identity";
import {
  findUserByEmail,
  grantRole,
  rolesOf as queryRoles,
  userRolesMigration,
} from "@lesto/identity";
import type { Identity } from "@lesto/identity";

import type { TraceSeams } from "@lesto/observability";

import { isDemoMode } from "./edge";
import { createDemoMailer } from "./emails/mailer";
import type { SentEmail } from "./emails/mailer";

/**
 * The committed demo identity secret — used ONLY in demo mode.
 *
 * >= 32 bytes so the secret-strength guard (`createIdentity`) accepts it. It is
 * public by design; a real deploy never reaches it (it is fenced behind
 * `LESTO_DEMO=1`, the same gate the edge secret uses).
 */
const DEMO_IDENTITY_SECRET = "estate-demo-identity-secret-0123456789";

/**
 * The identity signing secret — FAIL CLOSED, mirroring `edgeSecret`.
 *
 * `LESTO_AUTH_SECRET` is preferred; absent it, the committed demo fallback is
 * reachable ONLY under `LESTO_DEMO=1`. Outside demo mode an unset secret THROWS
 * rather than signing verification/reset tokens with a public key.
 *
 * This is the *serve* path's resolution. The static prerender (`build.ts`) signs
 * no tokens, so it passes an explicit throwaway secret to `buildIdentity` and
 * never reaches this fail-closed branch — a CI build needs no runtime secret.
 */
function identitySecret(): string {
  const secret = process.env["LESTO_AUTH_SECRET"];

  if (secret !== undefined) return secret;

  if (isDemoMode()) return DEMO_IDENTITY_SECRET;

  throw new Error(
    "LESTO_AUTH_SECRET is not set and LESTO_DEMO is not enabled. Refusing to build identity: set " +
      "LESTO_AUTH_SECRET, or set LESTO_DEMO=1 to run the demo with its committed fallback secret.",
  );
}

/** A demo seed: an account that exists out of the box, pre-verified. */
export interface DemoAccount {
  readonly id: "jade" | "guest";
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  /**
   * The roles this account holds — the ground truth seeded into the `user_roles`
   * store (OCP-5). Jade is the operator; Guest a read-only viewer. The lab's authz
   * resolves these from the store per request, no `?role=` knob.
   */
  readonly roles: readonly string[];
}

/**
 * The two preset accounts.
 *
 * Plainly-advertised demo credentials — there are no secrets here, just the
 * fixture data the demo runs on. They sit out of band of any real deploy
 * (an app embedding `@lesto/identity` would seed its own users instead).
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    id: "jade",
    email: "jade@demo.example.com",
    password: "demo-password-jade",
    displayName: "Jade Mills",
    roles: ["admin"],
  },
  {
    id: "guest",
    email: "guest@demo.example.com",
    password: "demo-password-guest",
    displayName: "Guest Buyer",
    roles: ["viewer"],
  },
];

/** The default demo account the sign-in form pre-fills. */
export const DEFAULT_DEMO = DEMO_ACCOUNTS[0]!;

/**
 * Insert the demo accounts and their role grants (idempotent — running twice is a
 * no-op). Roles are keyed by the demo `id` (`jade`/`guest`) — the same canonical
 * actor string the lab's session resolver produces (`controllers.ts`), so a request
 * signed in as Jade resolves `["admin"]` straight from the `user_roles` store.
 */
async function seedDemoAccounts(db: Db): Promise<void> {
  const now = new Date().toISOString();

  for (const demo of DEMO_ACCOUNTS) {
    if (!(await findUserByEmail(db, demo.email))) {
      await insertUser(db, {
        email: demo.email,
        passwordHash: await hashPassword(demo.password),
        // Seeded users are born verified — the demo skips the email click.
        emailVerifiedAt: now,
      });
    }

    // `grantRole` is itself idempotent, so re-seeding never duplicates a grant.
    for (const role of demo.roles) {
      await grantRole(db, demo.id, role);
    }
  }
}

/**
 * Build a fresh Identity wired to a fresh in-memory DB, with the demo seeded.
 *
 * Returns the raw `sql` handle too: the app threads it into `createApp`'s `db`
 * slot, so the kernel and the identity service share one connection. Identity
 * owns its own migration + seed here (run before the service is built), so the
 * kernel has no migrations of its own to run.
 *
 * The DB is opened through `@lesto/runtime`'s `openSqlite` (better-sqlite3 under
 * Node, `bun:sqlite` under Bun) — which is what lets `lesto.app.ts` boot under
 * either runtime. That async open is why this function is async.
 */
export async function buildIdentity(
  secret?: string,
  /**
   * The tracer's seam hooks (operability-dx item 3). When wired, every executed
   * query becomes a `db.query` span, every auth lifecycle event an
   * `identity.<type>` span, and every rendered email a `mail.delivered` span —
   * each a child of the in-flight request span. Absent (a static build, a unit
   * test) runs untraced, exactly as before. This is the canonical dogfood: the
   * SAME seam signatures a production app wires.
   */
  seams?: TraceSeams,
): Promise<{
  identity: Identity;
  handle: SqlDatabase;
  close: () => void;
  /** The demo mailer's record of rendered verify/reset emails (see {@link createDemoMailer}). */
  outbox: readonly SentEmail[];
  /**
   * The `rolesOf` seam bound to this identity's DB — the durable replacement for the
   * lab's old hard-coded role map (OCP-5). The app threads it into the lab's principal
   * resolver, so authz reads the seeded `user_roles` store, not a `?role=` knob.
   */
  rolesOf: (actor: string) => Promise<string[]>;
}> {
  const { db: sql, close } = await openSqlite();

  // Order is the contract: migrate, build the db, seed, then the service.
  // A query before migrate would hit an empty schema. The TOTP factor tables
  // (ADR 0020) migrate alongside users so the demo's second-factor enrollment
  // has somewhere to land; the `user_roles` store (ADR 0028 OCP-5) migrates here
  // too so the seeded role grants and the lab's authz resolution have a table.
  await new Migrator(sql, [usersMigration, totpMigration, userRolesMigration]).migrate();
  await installSessionSchema(sql);
  await installRateLimitSchema(sql);

  // Wire `db.onQuery` to the tracer: every executed query becomes a child span of
  // the request that ran it. The seeded-account queries above run before the db
  // is instrumented (boot work, not a request), so only request-time queries
  // trace — exactly what we want.
  const db = createDb(sql, seams === undefined ? {} : { onQuery: seams.onQuery });
  await seedDemoAccounts(db);

  // The demo's mailer renders real react-email templates (no SMTP; it records
  // them). A genuine onboarding/reset flow therefore produces real HTML — the
  // seeded accounts arrive pre-verified, so they send nothing. When tracing is
  // on, each rendered message emits a `mail.delivered` span through the seam.
  const mailer = createDemoMailer(
    undefined,
    seams === undefined
      ? undefined
      : () => seams.onDelivered({ mailerName: "identity", jobId: 0, attempt: 1 }),
  );

  const identity = createIdentity({
    db,
    // Each auth lifecycle event (login, verify, reset, revoke) becomes an
    // `identity.<type>` span — the observability seam wired to the tracer.
    ...(seams === undefined ? {} : { onEvent: seams.onEvent }),
    sessionStore: sqlSessionStore(sql),
    // The INNER, per-account login throttle (auth-security item 4): five failed
    // attempts per ~15 minutes for one account, fleet-correct over the shared SQL
    // store. This is the credential-stuffing defense — it bounds guesses against
    // ONE account no matter how many IPs they come from. The IP-keyed limiter on
    // `secureStack({ rateLimit })` is the OUTER moat (per-client request rate); a
    // botnet rotating IPs slips that, which is exactly what this layer closes.
    loginRateLimiter: new RateLimiter({
      store: sqlRateLimitStore(sql),
      capacity: 5,
      refillPerSecond: 5 / (15 * 60),
    }),
    // The per-account SECOND-FACTOR throttle (auth-security): five failed TOTP /
    // recovery-code attempts per ~15 minutes for one account, fleet-correct over
    // the shared SQL store. Once a password is stolen the 6-digit code is the only
    // barrier left — this bounds an attacker iterating codes against ONE account.
    totpRateLimiter: new RateLimiter({
      store: sqlRateLimitStore(sql),
      capacity: 5,
      refillPerSecond: 5 / (15 * 60),
    }),
    // An explicit secret (the static prerender passes a throwaway one — it signs
    // no tokens) overrides the fail-closed runtime resolution. Absent it, the
    // serve/Worker paths still demand a real `LESTO_AUTH_SECRET` (or `LESTO_DEMO=1`).
    secret: secret ?? identitySecret(),
    mailer,
    // The issuer label the user's authenticator app shows for the enrolled TOTP
    // factor (ADR 0020).
    appName: "Jade Mills Estates",
    verificationUrl: (token) => `/mls/api/verify?token=${token}`,
    resetUrl: (token) => `/mls/api/reset?token=${token}`,
  });

  return {
    identity,
    handle: sql,
    close,
    outbox: mailer.outbox,
    rolesOf: (actor) => queryRoles(db, actor),
  };
}
