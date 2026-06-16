/**
 * Assemble the mailing-list app from its parts.
 *
 * One composable `keel()` app exposes the whole double-opt-in journey as real
 * HTTP routes over the `@keel/mailing-lists` service:
 *
 *   POST /lists/:listId/subscribe    begin double opt-in (RATE-LIMITED)
 *   GET  /confirm/:token             complete double opt-in
 *   GET  /unsubscribe/:token         one-click opt out
 *   POST /lists/:listId/broadcast    fan an issue out to subscribed recipients
 *
 * The service is transport-agnostic: it hands delivery jobs to a `@keel/mail`
 * Mailer, which enqueues them on `@keel/queue`. Nothing is sent inline — a
 * worker (serve.ts) or a drain loop (run.ts / the test) processes the queue.
 *
 * `buildMailingListsApp` is the pure routes-over-a-service factory (the unit a
 * test drives); `buildApp` is the boot wiring that stands up the db, queue,
 * mailer, and service and seeds a list. Built as factories so the handlers close
 * over their dependencies — no module-scoped globals.
 */

import { z } from "zod";

import { createDb } from "@keel/db";
import type { Db } from "@keel/db";
import { createApp } from "@keel/kernel";
import type { App, KernelDatabase } from "@keel/kernel";
import { Mailer } from "@keel/mail";
import type { MailTransport } from "@keel/mail";
import {
  createMailingLists,
  insertList,
  MailingListError,
  mailingListsMigration,
} from "@keel/mailing-lists";
import type { List, MailingLists } from "@keel/mailing-lists";
import { installSchema, Queue } from "@keel/queue";
import { rateLimit } from "@keel/ratelimit";
import { fromRequestMiddleware, keel } from "@keel/web";
import type { Keel, Middleware } from "@keel/web";

import { defineMailers } from "./mailers";

/** Minimal HTML-escape for the one place we reflect a user's email into a page. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Boundary validation (ADR 0005): the body is untrusted until it parses. We keep
// the email shape check to the service (it owns the canonical rule + coded error)
// and only assert the field is present and a string here.
const subscribeSchema = z.object({ email: z.string() });
const broadcastSchema = z.object({ issue: z.coerce.number().int().positive() });

/**
 * The routes, closing over the `@keel/mailing-lists` service they front and the
 * middleware that rate-limits the public `subscribe` endpoint.
 *
 * `subscribe` is fronted by `fromRequestMiddleware(subscribeLimiter)` because the
 * package's contract is explicit: *the HTTP boundary that fronts `subscribe` MUST
 * rate-limit it* — it sends an email per call, so it is a spam/abuse amplifier
 * left open. The limiter is injected so a deployment chooses the policy (and a
 * test can make it deterministic).
 */
export function buildMailingListsApp(deps: {
  lists: MailingLists;
  subscribeLimiter: Middleware;
}): Keel {
  const { lists, subscribeLimiter } = deps;

  return keel()
    .post("/lists/:listId/subscribe", fromRequestMiddleware(subscribeLimiter), async (c) => {
      const listId = Number(c.param("listId"));
      if (!Number.isInteger(listId)) return c.json({ error: "Unknown list." }, 404);

      const { email } = c.valid(subscribeSchema);

      try {
        const sub = await lists.subscribe(listId, email);

        // 202: accepted, confirmation email enqueued — the address is pending
        // until the recipient clicks the link. Double opt-in never confirms here.
        return c.json({ status: sub.status, email: sub.email }, 202);
      } catch (error) {
        if (error instanceof MailingListError && error.code === "MAILING_LIST_INVALID_EMAIL") {
          return c.json({ error: error.message }, 422);
        }

        throw error;
      }
    })
    .get("/confirm/:token", async (c) => {
      try {
        const sub = await lists.confirm(c.param("token"));

        return c.html(`<h1>You're subscribed 🎉</h1><p>${escapeHtml(sub.email)} is confirmed.</p>`);
      } catch (error) {
        if (error instanceof MailingListError) {
          return c.html("<h1>Invalid or expired confirmation link.</h1>", 404);
        }

        throw error;
      }
    })
    .get("/unsubscribe/:token", async (c) => {
      try {
        const sub = await lists.unsubscribe(c.param("token"));

        return c.html(
          `<h1>Unsubscribed.</h1><p>${escapeHtml(sub.email)} won't receive further mail.</p>`,
        );
      } catch (error) {
        if (error instanceof MailingListError) {
          return c.html("<h1>Invalid unsubscribe link.</h1>", 404);
        }

        throw error;
      }
    })
    .post("/lists/:listId/broadcast", async (c) => {
      // A real app gates this behind operator auth — it sends to everyone. Kept
      // open here to keep the example to ONE battery; the gap is noted in README.
      const listId = Number(c.param("listId"));
      if (!Number.isInteger(listId)) return c.json({ error: "Unknown list." }, 404);

      const { issue } = c.valid(broadcastSchema);
      const result = await lists.broadcast(listId, "digest", { issue });

      return c.json(result, 202);
    });
}

/** What `buildApp` returns: the booted app plus the handles run.ts/serve/tests need. */
export interface Booted {
  app: App;
  db: Db;
  queue: Queue;
  lists: MailingLists;
  list: List;
}

export interface BuildOptions {
  /** The kernel database handle (from `@keel/runtime`'s `openSqlite`). */
  handle: KernelDatabase;

  /** Where rendered mail is delivered — a real SMTP/provider transport, or a capture in tests. */
  transport: MailTransport;

  /** The absolute origin the confirm / unsubscribe links are built against. */
  baseUrl: string;

  /**
   * The middleware fronting `subscribe`. Defaults to an in-memory token bucket
   * (5 burst, 1/s refill) keyed by client IP. Inject to set a fleet-shared SQL
   * limiter, a different policy, or a deterministic one for a test.
   */
  subscribeLimiter?: Middleware;
}

/**
 * Boot the whole thing: wrap the handle as a typed `Db`, stand up the queue +
 * mailer + service, run migrations through the kernel, install the queue schema,
 * and seed one list to subscribe to.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const { handle, transport, baseUrl } = options;
  const db = createDb(handle);

  // The mailer rides @keel/queue. The Queue object is just a handle here — it
  // touches no table until a job is enqueued/run, so we build it before migrate.
  // One unified `SqlDatabase` flows from the kernel handle into both @keel/db and
  // @keel/queue, so there is no cast.
  const queue = new Queue({ db: handle });

  const mailer = new Mailer({ queue, transport });
  defineMailers(mailer);

  const lists = createMailingLists({
    db,
    mailer,
    confirmationMailer: {
      name: "confirm",
      confirmUrl: (token) => `${baseUrl}/confirm/${token}`,
    },
    unsubscribeUrl: (token) => `${baseUrl}/unsubscribe/${token}`,
  });

  const subscribeLimiter =
    options.subscribeLimiter ?? rateLimit({ capacity: 5, refillPerSecond: 1 });

  // The kernel migrates the mailing-list schema, installs the durable-store
  // schema, then runs each `schemas` installer — so the mail battery declares its
  // @keel/queue schema once and the kernel creates the queue tables before
  // dispatch is live. No separate post-boot install, no cast.
  const app = await createApp({
    db: handle,
    app: buildMailingListsApp({ lists, subscribeLimiter }),
    migrations: [mailingListsMigration],
    schemas: [installSchema],
  });

  const list = await insertList(db, { name: "Weekly Digest" });

  return { app, db, queue, lists, list };
}
