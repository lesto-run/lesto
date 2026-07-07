/**
 * The example's QA gate: drive @lesto/workflows step memoization through the REAL
 * HTTP routes, asserting the exactly-once guarantees only an end-to-end wiring can
 * prove — a re-post replays every step (no double charge); a run that fails at the
 * receipt step resumes on retry with the charge REPLAYED, not repeated.
 *
 * `sleep` is injected so the settlement pause never waits on a real timer.
 */

import { describe, expect, it } from "vitest";

import { openSqlite } from "@lesto/runtime";
import type { Sleep } from "@lesto/workflows";

import { buildApp, createCheckoutServices } from "../src/app";

const BODY = { card: "tok_ada", amountCents: 4200 };

async function boot(options: { failReceiptTimes?: number } = {}) {
  const { db: handle, close } = await openSqlite();

  const sleepCalls: number[] = [];
  const sleep: Sleep = async (ms) => {
    sleepCalls.push(ms);
  };

  const services = createCheckoutServices(
    options.failReceiptTimes === undefined ? {} : { failReceiptTimes: options.failReceiptTimes },
  );

  const booted = await buildApp({ handle, services, sleep });

  const checkout = (orderId: string, body: unknown = BODY) =>
    booted.app.handle("POST", `/checkout/${orderId}`, { body });

  const traceOf = async (orderId: string): Promise<{ step: string; replayed: boolean }[]> => {
    const res = await booted.app.handle("GET", `/checkout/${orderId}/trace`);

    return JSON.parse(res.body as string) as { step: string; replayed: boolean }[];
  };

  return { ...booted, sleepCalls, checkout, traceOf, close };
}

describe("@lesto/workflows example — the checkout journey over HTTP", () => {
  it("runs every step once and returns a receipt", async () => {
    const { services, checkout, traceOf, close } = await boot();

    try {
      const res = await checkout("order-1");
      expect(res.status).toBe(200);

      const receipt = JSON.parse(res.body as string) as Record<string, string>;
      expect(receipt.chargeId).toMatch(/^charge_4200_1$/);
      expect(receipt.reservationId).toMatch(/^resv_order-1_1$/);
      expect(receipt.receiptId).toMatch(/^rcpt_/);

      expect(services.calls).toEqual({ charges: 1, reservations: 1, receipts: 1 });
      expect(await traceOf("order-1")).toEqual([
        { step: "charge", replayed: false },
        { step: "reserve", replayed: false },
        { step: "receipt", replayed: false },
      ]);
    } finally {
      close();
    }
  });

  it("replays every step on a re-post — the card is charged exactly once", async () => {
    const { services, checkout, traceOf, close } = await boot();

    try {
      const first = await checkout("order-1");
      const replay = await checkout("order-1");
      expect(replay.status).toBe(200);

      // Byte-identical receipt: the second run returned the journaled values.
      expect(replay.body).toBe(first.body);
      // No side effect ran a second time.
      expect(services.calls).toEqual({ charges: 1, reservations: 1, receipts: 1 });

      // The replay pass emitted a replayed event for each step.
      const trace = await traceOf("order-1");
      expect(trace.slice(3)).toEqual([
        { step: "charge", replayed: true },
        { step: "reserve", replayed: true },
        { step: "receipt", replayed: true },
      ]);
    } finally {
      close();
    }
  });

  it("resumes after a failed step without re-charging", async () => {
    const { services, checkout, traceOf, close } = await boot({ failReceiptTimes: 1 });

    try {
      // First attempt: charge + reserve succeed, the mailer is down, run fails.
      const failed = await checkout("order-2");
      expect(failed.status).toBe(502);
      expect(JSON.parse(failed.body as string)).toMatchObject({ resumable: true });
      expect(services.calls).toEqual({ charges: 1, reservations: 1, receipts: 0 });

      // A throwing step emits no trace event, so only the two that completed show.
      expect(await traceOf("order-2")).toEqual([
        { step: "charge", replayed: false },
        { step: "reserve", replayed: false },
      ]);

      // Retry the SAME order: charge + reserve REPLAY (no double charge), and only
      // the previously-failed receipt step re-executes — now that the mailer is up.
      const resumed = await checkout("order-2");
      expect(resumed.status).toBe(200);
      expect(services.calls).toEqual({ charges: 1, reservations: 1, receipts: 1 });

      expect(await traceOf("order-2")).toEqual([
        { step: "charge", replayed: false },
        { step: "reserve", replayed: false },
        { step: "charge", replayed: true },
        { step: "reserve", replayed: true },
        { step: "receipt", replayed: false },
      ]);
    } finally {
      close();
    }
  });

  it("awaits the injected settlement sleep instead of a real timer", async () => {
    const { sleepCalls, checkout, close } = await boot();

    try {
      await checkout("order-1");
      // The workflow paused once, for the settlement window — but through the
      // injected sleep, so the test never actually waited a second.
      expect(sleepCalls).toEqual([1_000]);
    } finally {
      close();
    }
  });

  it("rejects a malformed body with 422", async () => {
    const { checkout, close } = await boot();

    try {
      expect((await checkout("order-1", {})).status).toBe(422);
      expect((await checkout("order-1", { card: 1, amountCents: 10 })).status).toBe(422);
      expect((await checkout("order-1", { card: "tok", amountCents: "lots" })).status).toBe(422);
    } finally {
      close();
    }
  });
});
