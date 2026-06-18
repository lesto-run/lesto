/**
 * Identity's verify/reset journey, DELIVERING through a real mail transport.
 *
 * `@lesto/identity`'s unit + over-the-wire tests use a fake `IdentityMailer` that
 * just captures the link. This suite wires the *real* delivery stack instead:
 *
 *   identity.register
 *     → IdentityMailer adapter enqueues through a real queue-backed `Mailer`
 *       → a worker renders the react-email template (html + plain-text)
 *         → `createFetchProviderTransport` delivers to a recorded fixture
 *           → we assert the rendered body + the signed link reached the wire,
 *             then follow that captured link back into `identity.verifyEmail`.
 *
 * Same path for `requestPasswordReset → resetPassword`. This closes
 * web-primitives item 1's "identity's verify/reset journey sends a real email
 * end-to-end in `packages/integration`" acceptance — the fetch-provider against
 * a recorded fixture, exactly as the plan allows.
 */

import Database from "better-sqlite3";
import { render } from "@react-email/render";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb } from "@lesto/db";
import { createFetchProviderTransport, Mailer } from "@lesto/mail";
import type { EmailRenderer, ProviderRequestBody } from "@lesto/mail";
import { Schema } from "@lesto/migrate";
import { installSchema, Queue } from "@lesto/queue";
import type { SqlDatabase } from "@lesto/queue";

import { createIdentity, usersMigration } from "@lesto/identity";
import type { Identity, IdentityMailer } from "@lesto/identity";

import { ResetPasswordEmail, VerifyEmail } from "./email-templates";

// ---------------------------------------------------------------------------
// A real async SqlDatabase over better-sqlite3 (shared by queue + identity).
// ---------------------------------------------------------------------------

function adapt(raw: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...(params as never[])),
        get: async (params = []) => statement.get(...(params as never[])),
        all: async (params = []) => statement.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

// ---------------------------------------------------------------------------
// The render hook — the production react-email path: html + plain-text.
// ---------------------------------------------------------------------------

const renderEmail: EmailRenderer = async (element) => ({
  html: await render(element as Parameters<typeof render>[0]),
  text: await render(element as Parameters<typeof render>[0], { plainText: true }),
});

// ---------------------------------------------------------------------------
// Boot: a real queue-backed Mailer delivering through a fetch-provider whose
// `fetch` is a recorded fixture (captures the delivered provider payload).
// ---------------------------------------------------------------------------

let raw: Database.Database;
let queue: Queue;
let identity: Identity;

/** Every message the fixture provider "accepted", as JSON the transport sent. */
let delivered: ProviderRequestBody[];

/** A recorded provider endpoint: 200 OK, capturing the posted body. */
const fixtureFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as ProviderRequestBody;
  delivered.push(body);

  return new Response(JSON.stringify({ id: body.messageId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/** Drain every ready job so the enqueued deliveries actually go out. */
async function drainQueue(): Promise<void> {
  // Bounded loop: deliver every ready job, stop when the queue is idle.
  for (let i = 0; i < 100; i += 1) {
    const result = await queue.runOnce();

    if (result === null) return;

    expect(result.outcome).toBe("done");
  }

  throw new Error("queue did not drain within 100 jobs");
}

beforeEach(async () => {
  raw = new Database(":memory:");
  const db = adapt(raw);

  await installSchema(db);
  // Apply the canonical users-table migration through the real Schema editor —
  // one DDL system, no coupling to identity's internal table value.
  await usersMigration.migration.up(new Schema(db, "sqlite"));

  queue = new Queue({ db });
  delivered = [];

  const transport = createFetchProviderTransport({
    endpoint: "https://provider.test/emails",
    apiKey: "test-key",
    defaultFrom: "Estate <no-reply@estate.test>",
    fetch: fixtureFetch,
  });

  const mailer = new Mailer({ queue, transport, render: renderEmail });

  // The typed templates: a wrong-shaped payload would be a compile error.
  const verifyTemplate = mailer.template<{ to: string; url: string }>(
    "identity.verify",
    ({ to, url }) => ({ to, subject: "Confirm your email", react: VerifyEmail({ url }) }),
  );
  const resetTemplate = mailer.template<{ to: string; url: string }>(
    "identity.reset",
    ({ to, url }) => ({ to, subject: "Reset your password", react: ResetPasswordEmail({ url }) }),
  );

  // The identity → mail seam: identity hands a link, the adapter enqueues it.
  const identityMailer: IdentityMailer = {
    sendVerificationEmail: async ({ to, url }) => {
      await verifyTemplate.send({ to, url });
    },
    sendPasswordResetEmail: async ({ to, url }) => {
      await resetTemplate.send({ to, url });
    },
  };

  identity = createIdentity({
    db: createDb(db),
    secret: "integration-test-secret-0123456789",
    mailer: identityMailer,
    verificationUrl: (token) => `https://app.test/auth/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/auth/reset?token=${token}`,
  });
});

afterEach(() => {
  raw.close();
});

// ---------------------------------------------------------------------------
// Helpers to read a delivered email back the way an inbox would.
// ---------------------------------------------------------------------------

/** The token query param out of a captured verify/reset link. */
function tokenFromUrl(url: string): string {
  const token = new URL(url).searchParams.get("token");
  expect(token).not.toBeNull();

  return token!;
}

/** The signed link in a delivered email (it appears in both html and text). */
function linkIn(email: ProviderRequestBody): string {
  const match = /https:\/\/app\.test\/auth\/\S+token=[^"<\s]+/.exec(email.text ?? email.html);
  expect(match).not.toBeNull();

  return match![0]!;
}

// ---------------------------------------------------------------------------
// The journeys
// ---------------------------------------------------------------------------

describe("identity verify journey delivers a real email end-to-end", () => {
  it("register → rendered verify email delivered → follow the link → verified", async () => {
    await identity.register("Ada@example.com", "correct horse staple");

    // The mail is queued, not sent inline; drain the worker so it goes out.
    expect(delivered).toHaveLength(0);
    await drainQueue();
    expect(delivered).toHaveLength(1);

    const email = delivered[0]!;

    // ---- the provider received a fully-formed, rendered message ----
    expect(email.to).toBe("ada@example.com");
    expect(email.from).toBe("Estate <no-reply@estate.test>");
    expect(email.subject).toBe("Confirm your email");
    expect(email.messageId).toMatch(/^lesto-mail-\d+$/);

    // ---- the rendered react-email body landed (html + plain-text alt) ----
    // The html keeps the heading's case; the plain-text render uppercases it and
    // strips all markup. Both carry the template's copy — that's the point of the
    // multipart alternative.
    expect(email.html).toContain("Confirm your email");
    expect(email.html).toContain("<");
    expect(email.text).toBeDefined();
    expect(email.text).toContain("CONFIRM YOUR EMAIL");
    expect(email.text).toContain("Confirm this address to activate your account");
    expect(email.text).not.toContain("<html");
    expect(email.text).not.toContain("<table");

    // ---- the signed link is present and actually works ----
    const link = linkIn(email);
    expect(email.html).toContain(link);
    const token = tokenFromUrl(link);

    // Following the captured link verifies the account for real.
    const verified = await identity.verifyEmail(token);
    expect(verified.email).toBe("ada@example.com");

    // And now a login that was blocked-on-verification succeeds.
    const { user } = await identity.login("ada@example.com", "correct horse staple");
    expect(user.email).toBe("ada@example.com");
  });
});

describe("identity reset journey delivers a real email end-to-end", () => {
  it("requestPasswordReset → rendered reset email delivered → follow the link → reset", async () => {
    // Arrange: a verified, logged-in-able account.
    await identity.register("rey@example.com", "first password here");
    await drainQueue();
    const verifyLink = linkIn(delivered[0]!);
    await identity.verifyEmail(tokenFromUrl(verifyLink));
    delivered = [];

    // Act: ask for a reset; drain so the reset email is delivered.
    await identity.requestPasswordReset("rey@example.com");
    await drainQueue();
    expect(delivered).toHaveLength(1);

    const email = delivered[0]!;

    // ---- the rendered reset email landed with its own copy + link ----
    expect(email.to).toBe("rey@example.com");
    expect(email.subject).toBe("Reset your password");
    expect(email.html).toContain("Reset your password");
    expect(email.text).toContain("RESET YOUR PASSWORD");
    expect(email.text).toContain("request to reset your password");

    // ---- follow the captured reset link; it must actually reset ----
    const token = tokenFromUrl(linkIn(email));
    const updated = await identity.resetPassword(token, "second password here");
    expect(updated.email).toBe("rey@example.com");

    // The old password is dead; the new one logs in.
    await expect(identity.login("rey@example.com", "first password here")).rejects.toThrow();
    const { user } = await identity.login("rey@example.com", "second password here");
    expect(user.email).toBe("rey@example.com");
  });

  it("the reset link is single-use — replaying it after the reset fails", async () => {
    await identity.register("finn@example.com", "original password!");
    await drainQueue();
    await identity.verifyEmail(tokenFromUrl(linkIn(delivered[0]!)));
    delivered = [];

    await identity.requestPasswordReset("finn@example.com");
    await drainQueue();
    const token = tokenFromUrl(linkIn(delivered[0]!));

    await identity.resetPassword(token, "rotated password!");

    // The signing secret mixed in the old hash, so the same token is now dead.
    await expect(identity.resetPassword(token, "third password!!")).rejects.toThrow();
  });
});
