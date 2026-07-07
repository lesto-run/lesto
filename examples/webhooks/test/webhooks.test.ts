/**
 * The example's QA gate: drive @lesto/webhooks through the REAL HTTP routes, both
 * directions. It proves what only an end-to-end wiring can: a sent webhook is
 * signed, delivered through the queue, and verified by the receiver; the SSRF
 * guard refuses a private/metadata destination; and the inbound `verifyRequest`
 * accepts a genuine request while rejecting a forged, replayed, or unsigned one.
 *
 * See `test/hosted.test.ts` for the companion test that drives the SAME receiver
 * through the real hosted edge→kernel pipeline (`toFetchHandler`), rather than
 * this file's in-process `app.handle`.
 */

import { describe, expect, it } from "vitest";

import { openSqlite } from "@lesto/runtime";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@lesto/webhooks";

import { buildApp, RECEIVER_URL, SHARED_SECRET, type ReceivedWebhook } from "../src/app";

async function boot() {
  const { db: handle, close } = await openSqlite();
  const booted = await buildApp({ handle });

  /** Run the queue to completion, collecting each job's terminal outcome. */
  const drain = async (): Promise<string[]> => {
    const outcomes: string[] = [];
    let result = await booted.queue.runOnce();
    while (result !== null) {
      outcomes.push(result.outcome);
      result = await booted.queue.runOnce();
    }

    return outcomes;
  };

  const received = async (): Promise<ReceivedWebhook[]> => {
    const res = await booted.app.handle("GET", "/received");

    return JSON.parse(res.body as string) as ReceivedWebhook[];
  };

  /**
   * POST a raw body straight at the inbound receiver with the given headers.
   * `rawBody`, not `body` — `/incoming` reads `c.req.rawBody` (see `src/app.ts`),
   * the same field a real transport (node/edge) populates from the wire bytes.
   */
  const postIncoming = (raw: string, headers: Record<string, string>) =>
    booted.app.handle("POST", "/incoming", { headers, rawBody: raw });

  return { ...booted, drain, received, postIncoming, close };
}

describe("@lesto/webhooks example — outbound + inbound over HTTP", () => {
  it("signs, queues, delivers, and verifies a webhook end to end", async () => {
    const { app, drain, received, fetchAttempts, close } = await boot();

    try {
      const order = await app.handle("POST", "/orders", {
        body: { orderId: "ord_1", amountCents: 2500, subscriberUrl: RECEIVER_URL },
      });
      expect(order.status).toBe(202);

      // Nothing delivered until the queue runs — the send is a job.
      expect(await received()).toHaveLength(0);

      const outcomes = await drain();
      expect(outcomes).toEqual(["done"]);

      // The guard ALLOWED this public URL, so a connection was actually attempted.
      expect(fetchAttempts).toEqual([RECEIVER_URL]);

      // The receiver verified the signature and recorded the SIGNED payload.
      const inbox = await received();
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toEqual({
        event: "order.paid",
        data: { orderId: "ord_1", amountCents: 2500 },
      });
    } finally {
      close();
    }
  });

  it("refuses to deliver to a private/SSRF destination — before any connection", async () => {
    const { app, drain, received, fetchAttempts, close } = await boot();

    try {
      // The cloud metadata address — a classic SSRF target. `subscriberUrl` is
      // attacker-influenced (a customer registers it), which is exactly why the
      // guard exists. The literal IP is judged private with no DNS lookup.
      //
      // The path is `/incoming` ON PURPOSE: if the guard were ever removed or
      // bypassed, the deliverer would dispatch the correctly-signed bytes to the
      // real receiver route, `verify()` would pass, the inbox would gain an entry,
      // and the outcome would be `"done"` — so the assertions below are genuine
      // discriminators, not a vacuous "delivery failed for some reason".
      const order = await app.handle("POST", "/orders", {
        body: {
          orderId: "ord_2",
          amountCents: 100,
          subscriberUrl: "http://169.254.169.254/incoming",
        },
      });
      expect(order.status).toBe(202);

      // The guard refuses it as a PERMANENT failure — retired after one attempt,
      // not retried.
      expect(await drain()).toEqual(["failed"]);

      // The real SSRF property: NO connection was ever attempted to the private
      // address (the guard runs before fetch), and nothing was delivered. Were the
      // guard bypassed, `fetchAttempts` would contain the URL and the inbox an entry.
      expect(fetchAttempts).toEqual([]);
      expect(await received()).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("accepts a correctly-signed inbound webhook", async () => {
    const { postIncoming, received, close } = await boot();

    try {
      const raw = JSON.stringify({ event: "order.refunded", data: { orderId: "ord_3" } });
      const timestamp = Date.now();
      const signature = sign(`${timestamp}.${raw}`, SHARED_SECRET);

      const res = await postIncoming(raw, {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: String(timestamp),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body as string)).toMatchObject({ verified: true });
      expect(await received()).toEqual([{ event: "order.refunded", data: { orderId: "ord_3" } }]);
    } finally {
      close();
    }
  });

  it("rejects a tampered body whose signature no longer matches", async () => {
    const { postIncoming, received, close } = await boot();

    try {
      const raw = JSON.stringify({
        event: "order.paid",
        data: { orderId: "ord_4", amountCents: 1 },
      });
      const timestamp = Date.now();
      const signature = sign(`${timestamp}.${raw}`, SHARED_SECRET);

      // An attacker bumps the amount but can't re-sign without the secret.
      const tampered = raw.replace('"amountCents":1', '"amountCents":1000000');

      const res = await postIncoming(tampered, {
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: String(timestamp),
      });

      expect(res.status).toBe(401);
      expect(await received()).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("rejects a replayed webhook whose timestamp is outside the tolerance", async () => {
    const { postIncoming, received, close } = await boot();

    try {
      const raw = JSON.stringify({ event: "order.paid", data: { orderId: "ord_5" } });
      // A genuine, correctly-signed capture — but from ten minutes ago, past the
      // five-minute default replay window.
      const staleTimestamp = Date.now() - 10 * 60 * 1000;
      const signature = sign(`${staleTimestamp}.${raw}`, SHARED_SECRET);

      const res = await postIncoming(raw, {
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: String(staleTimestamp),
      });

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body as string)).toMatchObject({
        reason: expect.stringContaining("stale"),
      });
      expect(await received()).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("rejects an unsigned inbound webhook", async () => {
    const { postIncoming, received, close } = await boot();

    try {
      const raw = JSON.stringify({ event: "order.paid", data: {} });
      const res = await postIncoming(raw, { "content-type": "application/json" });

      expect(res.status).toBe(401);
      expect(await received()).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("returns 422 (not 500) for a correctly-signed body that isn't an { event, data } envelope", async () => {
    const { postIncoming, received, close } = await boot();

    try {
      // A genuinely-signed bare `null`: verifyRequest accepts the signature but
      // extracts no event. The receiver must reject cleanly — an unguarded
      // JSON.parse(rawBody).event would throw and 500 the endpoint.
      const raw = "null";
      const timestamp = Date.now();
      const signature = sign(`${timestamp}.${raw}`, SHARED_SECRET);

      const res = await postIncoming(raw, {
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: String(timestamp),
      });

      expect(res.status).toBe(422);
      expect(await received()).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("rejects a malformed order with 422", async () => {
    const { app, close } = await boot();

    try {
      expect((await app.handle("POST", "/orders", { body: {} })).status).toBe(422);
      expect(
        (
          await app.handle("POST", "/orders", {
            body: { orderId: "x", amountCents: "lots", subscriberUrl: RECEIVER_URL },
          })
        ).status,
      ).toBe(422);
    } finally {
      close();
    }
  });
});
