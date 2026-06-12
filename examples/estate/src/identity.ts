/**
 * The estate's identity layer — `@keel/identity` over an in-memory SQLite.
 *
 * This replaces the old `?as=<id>` impersonation demo (which had no
 * credential check at all) with the real Keel auth flow: a sign-in posts an
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

import { hashPassword, installSessionSchema, sqlSessionStore } from "@keel/auth";
import { createDb } from "@keel/db";
import type { Db, SqlDatabase } from "@keel/db";
import { Migrator } from "@keel/migrate";
import { openSqlite } from "@keel/runtime";

import { createIdentity, insertUser, usersMigration } from "@keel/identity";
import { findUserByEmail } from "@keel/identity";
import type { Identity, IdentityMailer } from "@keel/identity";

import { isDemoMode } from "./edge";

/**
 * The committed demo identity secret — used ONLY in demo mode.
 *
 * >= 32 bytes so the secret-strength guard (`createIdentity`) accepts it. It is
 * public by design; a real deploy never reaches it (it is fenced behind
 * `KEEL_DEMO=1`, the same gate the edge secret uses).
 */
const DEMO_IDENTITY_SECRET = "estate-demo-identity-secret-0123456789";

/**
 * The identity signing secret — FAIL CLOSED, mirroring `edgeSecret`.
 *
 * `KEEL_AUTH_SECRET` is preferred; absent it, the committed demo fallback is
 * reachable ONLY under `KEEL_DEMO=1`. Outside demo mode an unset secret THROWS
 * rather than signing verification/reset tokens with a public key.
 *
 * This is the *serve* path's resolution. The static prerender (`build.ts`) signs
 * no tokens, so it passes an explicit throwaway secret to `buildIdentity` and
 * never reaches this fail-closed branch — a CI build needs no runtime secret.
 */
function identitySecret(): string {
  const secret = process.env["KEEL_AUTH_SECRET"];

  if (secret !== undefined) return secret;

  if (isDemoMode()) return DEMO_IDENTITY_SECRET;

  throw new Error(
    "KEEL_AUTH_SECRET is not set and KEEL_DEMO is not enabled. Refusing to build identity: set " +
      "KEEL_AUTH_SECRET, or set KEEL_DEMO=1 to run the demo with its committed fallback secret.",
  );
}

/** A demo seed: an account that exists out of the box, pre-verified. */
export interface DemoAccount {
  readonly id: "jade" | "guest";
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

/**
 * The two preset accounts.
 *
 * Plainly-advertised demo credentials — there are no secrets here, just the
 * fixture data the demo runs on. They sit out of band of any real deploy
 * (an app embedding `@keel/identity` would seed its own users instead).
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    id: "jade",
    email: "jade@demo.example.com",
    password: "demo-password-jade",
    displayName: "Jade Mills",
  },
  {
    id: "guest",
    email: "guest@demo.example.com",
    password: "demo-password-guest",
    displayName: "Guest Buyer",
  },
];

/** The default demo account the sign-in form pre-fills. */
export const DEFAULT_DEMO = DEMO_ACCOUNTS[0]!;

/** Insert the demo accounts (idempotent — running twice is a no-op). */
async function seedDemoAccounts(db: Db): Promise<void> {
  const now = new Date().toISOString();

  for (const demo of DEMO_ACCOUNTS) {
    if (await findUserByEmail(db, demo.email)) continue;

    await insertUser(db, {
      email: demo.email,
      passwordHash: hashPassword(demo.password),
      // Seeded users are born verified — the demo skips the email click.
      emailVerifiedAt: now,
    });
  }
}

/**
 * A null mailer.
 *
 * The estate demo never actually sends email — the seeded accounts arrive
 * pre-verified, and no production "forgot password" flow runs in a demo.
 * Identity still requires *an* outbound seam, so this is the explicit no-op.
 */
const silentMailer: IdentityMailer = {
  sendVerificationEmail: () => {},
  sendPasswordResetEmail: () => {},
};

/**
 * Build a fresh Identity wired to a fresh in-memory DB, with the demo seeded.
 *
 * Returns the raw `sql` handle too: the app threads it into `createApp`'s `db`
 * slot, so the kernel and the identity service share one connection. Identity
 * owns its own migration + seed here (run before the service is built), so the
 * kernel has no migrations of its own to run.
 *
 * The DB is opened through `@keel/runtime`'s `openSqlite` (better-sqlite3 under
 * Node, `bun:sqlite` under Bun) — which is what lets `keel.app.ts` boot under
 * either runtime. That async open is why this function is async.
 */
export async function buildIdentity(secret?: string): Promise<{
  identity: Identity;
  handle: SqlDatabase;
  close: () => void;
}> {
  const { db: sql, close } = await openSqlite();

  // Order is the contract: migrate, build the db, seed, then the service.
  // A query before migrate would hit an empty schema.
  await new Migrator(sql, [usersMigration]).migrate();
  await installSessionSchema(sql);
  const db = createDb(sql);
  await seedDemoAccounts(db);

  const identity = createIdentity({
    db,
    sessionStore: sqlSessionStore(sql),
    // An explicit secret (the static prerender passes a throwaway one — it signs
    // no tokens) overrides the fail-closed runtime resolution. Absent it, the
    // serve/Worker paths still demand a real `KEEL_AUTH_SECRET` (or `KEEL_DEMO=1`).
    secret: secret ?? identitySecret(),
    mailer: silentMailer,
    // Demo never sends mail; these URLs exist only so the option types are
    // satisfied. If you flip the demo into a real onboarding flow, swap them.
    verificationUrl: (token) => `/mls/api/verify?token=${token}`,
    resetUrl: (token) => `/mls/api/reset?token=${token}`,
  });

  return { identity, handle: sql, close };
}
