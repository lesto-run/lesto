import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithContext } from "@keel/web";

import {
  MemoryRateLimitStore,
  RateLimiter,
  rateLimit,
  RATELIMIT_UNKNOWN_CLIENT_CODE,
  UNKNOWN_CLIENT_KEY,
} from "../src/index";

import type { AnyKeelResponse, KeelRequest } from "@keel/web";
import type { BucketState } from "../src/index";

/**
 * Read a bucket without mutating it — the store has no `get`, only the atomic
 * `update`, so probe by returning the current state unchanged.
 */
async function bucketAt(
  store: MemoryRateLimitStore,
  key: string,
): Promise<BucketState | undefined> {
  let seen: BucketState | undefined;
  await store.update(key, (current) => {
    seen = current;
    return current ?? { tokens: 0, updatedAt: 0 };
  });
  return seen;
}

const request: KeelRequest = {
  method: "GET",
  path: "/",
  params: {},
  query: {},
  headers: {},
  body: undefined,
};

const okResponse: AnyKeelResponse = { status: 200, headers: {}, body: "ok" };

/** A limiter over a fixed clock so deny/allow are deterministic. */
function fixedLimiter(capacity: number, refillPerSecond: number, now = 1000): RateLimiter {
  return new RateLimiter({
    store: new MemoryRateLimitStore(),
    capacity,
    refillPerSecond,
    clock: () => now,
  });
}

describe("rateLimit middleware", () => {
  it("allows a request while the bucket has tokens", async () => {
    const middleware = rateLimit({ capacity: 2, refillPerSecond: 1 });

    const response = await middleware(request, async () => okResponse);

    expect(response.status).toBe(200);
  });

  it("answers 429 with Retry-After once the bucket is empty", async () => {
    // capacity 1, no refill within the frozen clock: the second call is denied.
    const limiter = fixedLimiter(1, 1);
    const middleware = rateLimit({ capacity: 1, refillPerSecond: 1, limiter });

    const first = await middleware(request, async () => okResponse);
    expect(first.status).toBe(200);

    const second = await middleware(request, async () => okResponse);

    expect(second.status).toBe(429);
    expect(second.body).toBe("Too Many Requests");
    // One token deficit at 1/s refill -> retry after 1 whole second.
    expect(second.headers["Retry-After"]).toBe("1");
  });

  it("keys by the request-context client IP, so distinct IPs get distinct buckets", async () => {
    const limiter = fixedLimiter(1, 1);
    const middleware = rateLimit({ capacity: 1, refillPerSecond: 1, limiter });

    // IP a spends its only token; IP b still has its own full bucket.
    const aFirst = await runWithContext({ requestId: "1", ip: "10.0.0.1" }, () =>
      middleware(request, async () => okResponse),
    );
    expect(aFirst.status).toBe(200);

    const aSecond = await runWithContext({ requestId: "2", ip: "10.0.0.1" }, () =>
      middleware(request, async () => okResponse),
    );
    expect(aSecond.status).toBe(429);

    const bFirst = await runWithContext({ requestId: "3", ip: "10.0.0.2" }, () =>
      middleware(request, async () => okResponse),
    );
    expect(bFirst.status).toBe(200);
  });

  it("falls back to one shared bucket when no client IP is resolvable", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new RateLimiter({ store, capacity: 5, refillPerSecond: 1, clock: () => 1000 });
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1, limiter });

    // No context, so the default key is the shared fallback.
    await middleware(request, async () => okResponse);

    // The bucket under the fallback key was touched — proof the fallback was used.
    expect(await bucketAt(store, UNKNOWN_CLIENT_KEY)).toBeDefined();
  });

  it("honors a custom keyFor", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new RateLimiter({ store, capacity: 5, refillPerSecond: 1, clock: () => 1000 });

    const middleware = rateLimit({
      capacity: 5,
      refillPerSecond: 1,
      limiter,
      keyFor: () => "tenant:acme",
    });

    await middleware(request, async () => okResponse);

    expect(await bucketAt(store, "tenant:acme")).toBeDefined();
  });

  it("builds a default limiter from capacity/refill when none is injected", async () => {
    // capacity 1 with the real clock: a tight burst of two trips the limit, so
    // the default-constructed limiter is exercised (not an injected one).
    const middleware = rateLimit({ capacity: 1, refillPerSecond: 0.0001 });

    const first = await middleware(request, async () => okResponse);
    const second = await middleware(request, async () => okResponse);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});

describe("rateLimit unresolved-client detection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires onUnknownClient once when the IP cannot be resolved, not per request", async () => {
    const onUnknownClient = vi.fn();
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1, onUnknownClient });

    // No context on either call: both fall back to the shared bucket.
    await middleware(request, async () => okResponse);
    await middleware(request, async () => okResponse);

    // Warn-once: the second context-less request must not re-fire the seam.
    expect(onUnknownClient).toHaveBeenCalledTimes(1);
  });

  it("does not fire onUnknownClient when the context resolves a client IP", async () => {
    const onUnknownClient = vi.fn();
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1, onUnknownClient });

    await runWithContext({ requestId: "1", ip: "10.0.0.1" }, () =>
      middleware(request, async () => okResponse),
    );

    expect(onUnknownClient).not.toHaveBeenCalled();
  });

  it("re-fires onUnknownClient after a resolvable request slips back to the fallback", async () => {
    const onUnknownClient = vi.fn();
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1, onUnknownClient });

    // Resolved first (no warning), then context-less (warns), then context-less
    // again (warn-once latch holds). The latch is set only by a real fallback,
    // so a resolved request in between does not reset it.
    await runWithContext({ requestId: "1", ip: "10.0.0.1" }, () =>
      middleware(request, async () => okResponse),
    );
    await middleware(request, async () => okResponse);
    await middleware(request, async () => okResponse);

    expect(onUnknownClient).toHaveBeenCalledTimes(1);
  });

  it("never fires onUnknownClient when a custom keyFor is supplied", async () => {
    const onUnknownClient = vi.fn();
    const middleware = rateLimit({
      capacity: 5,
      refillPerSecond: 1,
      keyFor: () => "tenant:acme",
      onUnknownClient,
    });

    // No context, but an explicit key means there is no unresolved fallback.
    await middleware(request, async () => okResponse);

    expect(onUnknownClient).not.toHaveBeenCalled();
  });

  it("defaults to a coded console.warn when no onUnknownClient is injected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1 });

    await middleware(request, async () => okResponse);

    expect(warn).toHaveBeenCalledTimes(1);
    // Logs branch on the stable code, never the prose.
    expect(warn.mock.calls[0]?.[0]).toContain(RATELIMIT_UNKNOWN_CLIENT_CODE);
  });
});
