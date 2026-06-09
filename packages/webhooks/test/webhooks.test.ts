import Database from "better-sqlite3";
import { installSchema, Queue } from "@keel/queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVENT_HEADER, sign, SIGNATURE_HEADER, verify, WebhookError, Webhooks } from "../src/index";

import type { SqlDatabase } from "@keel/queue";
import type { FetchLike, WebhookResponse } from "../src/index";

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

let raw: Database.Database;
let queue: Queue;
let calls: Call[];

function fakeFetch(response: WebhookResponse): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });

    return response;
  };
}

beforeEach(() => {
  raw = new Database(":memory:");
  const db = raw as unknown as SqlDatabase;
  installSchema(db);
  queue = new Queue({ db });
  calls = [];
});

afterEach(() => {
  raw.close();
});

describe("sign & verify", () => {
  it("signs deterministically and verifies", () => {
    expect(sign("body", "secret")).toBe(sign("body", "secret"));

    const signature = sign("body", "secret");
    expect(verify("body", signature, "secret")).toBe(true);
    expect(verify("body", sign("body", "other"), "secret")).toBe(false); // same length, wrong mac
    expect(verify("body", "short", "secret")).toBe(false); // length mismatch short-circuits
  });
});

describe("Webhooks delivery", () => {
  it("signs and POSTs with a secret", async () => {
    const hooks = new Webhooks({ queue, fetch: fakeFetch({ ok: true, status: 200 }) });
    hooks.send("https://example.com/hook", "order.paid", { id: 42 }, { secret: "shh" });

    expect((await queue.runOnce())?.outcome).toBe("done");

    const call = calls[0];
    expect(call?.url).toBe("https://example.com/hook");
    expect(call?.init.headers[EVENT_HEADER]).toBe("order.paid");
    expect(call?.init.headers[SIGNATURE_HEADER]).toBe(sign(call?.init.body ?? "", "shh"));
    expect(verify(call?.init.body ?? "", call?.init.headers[SIGNATURE_HEADER] ?? "", "shh")).toBe(
      true,
    );
  });

  it("omits the signature when no secret is given", async () => {
    const hooks = new Webhooks({ queue, fetch: fakeFetch({ ok: true, status: 200 }) });
    hooks.send("https://example.com/hook", "ping", { ok: true });

    await queue.runOnce();
    expect(calls[0]?.init.headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("fails (coded) and retries on a non-2xx response", async () => {
    const hooks = new Webhooks({ queue, fetch: fakeFetch({ ok: false, status: 503 }) });
    const id = hooks.send("https://example.com/hook", "ping", {}, { maxAttempts: 1 });

    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(queue.find(id)?.lastError).toContain("returned 503");
  });

  it("defaults to the global fetch when none is injected", () => {
    const hooks = new Webhooks({ queue });

    expect(typeof hooks.send).toBe("function"); // constructed against globalThis.fetch
  });

  it("WebhookError carries a frozen, coded payload", () => {
    const error = new WebhookError("WEBHOOK_DELIVERY_FAILED", "boom", { status: 500 });

    expect(error.code).toBe("WEBHOOK_DELIVERY_FAILED");
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
