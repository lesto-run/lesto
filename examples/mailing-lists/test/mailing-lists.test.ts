/**
 * The example's QA gate: drive the whole double-opt-in journey through the REAL
 * HTTP routes (not the service methods directly), the way a browser would.
 *
 * It asserts the things only an end-to-end wiring can prove: that `subscribe`
 * enqueues a confirmation email whose link actually confirms; that a broadcast
 * reaches each subscribed recipient exactly once and carries List-Unsubscribe;
 * that the unsubscribe link works; and that the package's mandated rate limit on
 * `subscribe` is actually mounted. Mail is captured by a fake transport and the
 * queue is drained by hand so every delivery is observable.
 */

import { describe, expect, it } from "vitest";

import { openSqlite } from "@lesto/runtime";
import { rateLimit } from "@lesto/ratelimit";
import { subscribedRecipients } from "@lesto/mailing-lists";
import type { Middleware } from "@lesto/web";
import type { RenderedEmail } from "@lesto/mail";

import { buildApp } from "../src/app";

const BASE_URL = "http://127.0.0.1";

/** Pull the token out of a `…/<marker>/<token>` link in rendered mail. */
function extractToken(haystack: string, marker: string): string {
  const at = haystack.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} link found in email`);

  return haystack.slice(at + marker.length).split(/["'>\s]/)[0] ?? "";
}

async function boot(subscribeLimiter?: Middleware) {
  const { db: handle, close } = await openSqlite();

  const outbox: RenderedEmail[] = [];
  const transport = {
    send: async (email: RenderedEmail): Promise<void> => {
      outbox.push(email);
    },
  };

  const booted = await buildApp({
    handle,
    transport,
    baseUrl: BASE_URL,
    // Permissive + deterministic by default, so journey tests aren't throttled
    // and the IP-less in-process path never warns.
    subscribeLimiter:
      subscribeLimiter ?? rateLimit({ capacity: 100, refillPerSecond: 100, keyFor: () => "test" }),
  });

  const drain = async (): Promise<void> => {
    while ((await booted.queue.runOnce()) !== null) {
      // keep draining until the queue is idle
    }
  };

  /** Subscribe + click the confirmation link the recipient received. */
  const subscribeAndConfirm = async (email: string): Promise<void> => {
    const res = await booted.app.handle("POST", `/lists/${booted.list.id}/subscribe`, {
      body: { email },
    });
    expect(res.status).toBe(202);

    await drain();
    const mail = outbox.find((m) => m.to === email && m.subject === "Confirm your subscription");
    if (mail === undefined) throw new Error(`no confirmation email for ${email}`);

    const confirm = await booted.app.handle(
      "GET",
      `/confirm/${extractToken(mail.html, "/confirm/")}`,
    );
    expect(confirm.status).toBe(200);
  };

  return { ...booted, outbox, drain, subscribeAndConfirm, close };
}

describe("@lesto/mailing-lists example — the journey over HTTP", () => {
  it("drives subscribe → confirm → broadcast → unsubscribe end to end", async () => {
    const { app, db, list, outbox, drain, close } = await boot();

    try {
      // 1. Subscribe — accepted as pending, confirmation email enqueued.
      const subscribed = await app.handle("POST", `/lists/${list.id}/subscribe`, {
        body: { email: "ada@example.com" },
      });
      expect(subscribed.status).toBe(202);
      expect(JSON.parse(subscribed.body as string)).toMatchObject({ status: "pending" });

      await drain();
      expect(outbox).toHaveLength(1);
      const [confirmEmail] = outbox;
      if (confirmEmail === undefined) throw new Error("no confirmation email");
      expect(confirmEmail.to).toBe("ada@example.com");
      expect(confirmEmail.subject).toBe("Confirm your subscription");
      expect(confirmEmail.html).toContain(`${BASE_URL}/confirm/`);
      // Not subscribed until the link is clicked — double opt-in.
      expect(await subscribedRecipients(db, list.id)).toHaveLength(0);

      // 2. Confirm — click the link.
      const token = extractToken(confirmEmail.html, "/confirm/");
      const confirmed = await app.handle("GET", `/confirm/${token}`);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body as string).toContain("subscribed");

      const recipients = await subscribedRecipients(db, list.id);
      expect(recipients).toHaveLength(1);
      expect(recipients[0]?.email).toBe("ada@example.com");

      // 3. Broadcast — fan issue #42 out to the one subscribed recipient.
      const broadcast = await app.handle("POST", `/lists/${list.id}/broadcast`, {
        body: { issue: 42 },
      });
      expect(broadcast.status).toBe(202);
      expect(JSON.parse(broadcast.body as string)).toMatchObject({ enqueued: 1 });

      await drain();
      expect(outbox).toHaveLength(2);
      const [, digest] = outbox;
      if (digest === undefined) throw new Error("no digest email");
      expect(digest.to).toBe("ada@example.com");
      expect(digest.subject).toBe("Weekly Digest — Issue #42");
      // The bulk-sender requirement rides through automatically.
      expect(digest.headers?.["List-Unsubscribe"]).toContain(`${BASE_URL}/unsubscribe/`);

      // 4. Unsubscribe — one-click, from the List-Unsubscribe header.
      const unsubToken = extractToken(digest.headers?.["List-Unsubscribe"] ?? "", "/unsubscribe/");
      const unsubscribed = await app.handle("GET", `/unsubscribe/${unsubToken}`);
      expect(unsubscribed.status).toBe(200);

      expect(await subscribedRecipients(db, list.id)).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("rate-limits subscribe per client, keyed off the request (finding #1)", async () => {
    // `keyFor` now receives the request, so we bucket by a client header even
    // in-process — where `app.handle` establishes no IP context for the default
    // key. capacity 1, ~no refill, so a client's second call in a burst is denied.
    const { app, list, outbox, drain, close } = await boot(
      rateLimit({
        capacity: 1,
        refillPerSecond: 0.01,
        keyFor: (req) => req.headers["x-client-id"] ?? "anon",
      }),
    );

    try {
      const clientA = { "x-client-id": "client-a" };
      const first = await app.handle("POST", `/lists/${list.id}/subscribe`, {
        headers: clientA,
        body: { email: "ada@example.com" },
      });
      expect(first.status).toBe(202);

      // Same client, second call in the burst → throttled.
      const second = await app.handle("POST", `/lists/${list.id}/subscribe`, {
        headers: clientA,
        body: { email: "ada-again@example.com" },
      });
      expect(second.status).toBe(429);

      // A DIFFERENT client has its own bucket → allowed. This is what request-
      // keying buys: real per-client limiting with no ambient IP context.
      const other = await app.handle("POST", `/lists/${list.id}/subscribe`, {
        headers: { "x-client-id": "client-b" },
        body: { email: "grace@example.com" },
      });
      expect(other.status).toBe(202);

      // Two distinct clients got through; the throttled retry sent no mail.
      await drain();
      expect(outbox.map((m) => m.to).toSorted()).toEqual(["ada@example.com", "grace@example.com"]);
    } finally {
      close();
    }
  });

  it("rejects a malformed body with 422 instead of crashing", async () => {
    const { app, list, close } = await boot();

    try {
      // Lesto has no request error boundary yet, so the routes validate the body
      // themselves — a missing/wrong-typed field must be a clean 422, never an
      // uncaught throw that would 500 the endpoint.
      const noEmail = await app.handle("POST", `/lists/${list.id}/subscribe`, { body: {} });
      expect(noEmail.status).toBe(422);

      const badEmail = await app.handle("POST", `/lists/${list.id}/subscribe`, {
        body: { email: 123 },
      });
      expect(badEmail.status).toBe(422);

      const noIssue = await app.handle("POST", `/lists/${list.id}/broadcast`, { body: {} });
      expect(noIssue.status).toBe(422);
    } finally {
      close();
    }
  });

  it("delivers a broadcast exactly once per subscribed recipient", async () => {
    const { app, list, outbox, drain, subscribeAndConfirm, close } = await boot();

    try {
      await subscribeAndConfirm("ada@example.com");
      await subscribeAndConfirm("grace@example.com");
      outbox.length = 0; // drop the two confirmation emails; keep only the digests

      const broadcast = await app.handle("POST", `/lists/${list.id}/broadcast`, {
        body: { issue: 7 },
      });
      expect(JSON.parse(broadcast.body as string)).toMatchObject({ enqueued: 2 });

      await drain();

      const digests = outbox.filter((m) => m.subject === "Weekly Digest — Issue #7");
      const recipients = digests.map((m) => m.to).toSorted();
      // Exactly one digest per recipient — no double-send across the full drain.
      expect(recipients).toEqual(["ada@example.com", "grace@example.com"]);
    } finally {
      close();
    }
  });
});
