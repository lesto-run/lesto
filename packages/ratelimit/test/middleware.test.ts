import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithContext } from "@lesto/web";

import {
  MemoryRateLimitStore,
  RateLimiter,
  rateLimit,
  RATELIMIT_DENIED_KIND,
  RATELIMIT_UNKNOWN_CLIENT_CODE,
  UNKNOWN_CLIENT_KEY,
} from "../src/index";

import type { AnyLestoResponse, LestoRequest } from "@lesto/web";
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

const request: LestoRequest = {
  method: "GET",
  path: "/",
  params: {},
  query: {},
  headers: {},
  body: undefined,
};

const okResponse: AnyLestoResponse = { status: 200, headers: {}, body: "ok" };

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

    // In a request context whose transport did not resolve a client IP, the
    // default key is the shared fallback — the in-request misconfig case.
    await runWithContext({ requestId: "1" }, () => middleware(request, async () => okResponse));

    // The bucket under the fallback key was touched — proof the fallback was used.
    expect(await bucketAt(store, UNKNOWN_CLIENT_KEY)).toBeDefined();
  });

  it("takes the same shared bucket silently when dispatched outside any request context", async () => {
    // The build prerender / batch task / out-of-transport test path: there is no
    // client to key on by design. Same bucket as the misconfig case (a missing
    // IP must always *tighten* the gate, never open it), but no warning.
    const store = new MemoryRateLimitStore();
    const limiter = new RateLimiter({ store, capacity: 5, refillPerSecond: 1, clock: () => 1000 });
    const onUnknownClient = vi.fn();
    const middleware = rateLimit({
      capacity: 5,
      refillPerSecond: 1,
      limiter,
      onUnknownClient,
    });

    await middleware(request, async () => okResponse);

    expect(await bucketAt(store, UNKNOWN_CLIENT_KEY)).toBeDefined();
    expect(onUnknownClient).not.toHaveBeenCalled();
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

  it("keys from the request itself, so distinct API keys get distinct buckets", async () => {
    // The whole point of the request-arg keyFor: bucket by request data (here an
    // API-key header) with no ambient context in play. capacity 1 + frozen clock
    // means each key gets exactly one token before it 429s.
    const store = new MemoryRateLimitStore();
    const limiter = new RateLimiter({ store, capacity: 1, refillPerSecond: 1, clock: () => 1000 });

    const middleware = rateLimit({
      capacity: 1,
      refillPerSecond: 1,
      limiter,
      keyFor: (req) => `api-key:${req.headers["x-api-key"] ?? "anon"}`,
    });

    const withKey = (apiKey: string): LestoRequest => ({
      ...request,
      headers: { "x-api-key": apiKey },
    });

    // "acme" spends its only token, then 429s — but "globex" still has a full
    // bucket, proving the key came straight off each request.
    expect((await middleware(withKey("acme"), async () => okResponse)).status).toBe(200);
    expect((await middleware(withKey("acme"), async () => okResponse)).status).toBe(429);
    expect((await middleware(withKey("globex"), async () => okResponse)).status).toBe(200);

    expect(await bucketAt(store, "api-key:acme")).toBeDefined();
    expect(await bucketAt(store, "api-key:globex")).toBeDefined();
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

  it("accepts and threads onSaturated into the auto-built per-IP store", async () => {
    // With no injected limiter, rateLimit builds a RateLimiter that routes
    // onSaturated into its per-IP MemoryRateLimitStore — the seam an operator uses
    // to observe the per-IP cap shedding buckets under a distinct-IP flood. That it
    // actually FIRES through the limiter→store path is proven end-to-end in the
    // limiter suite; here we cover that the middleware accepts + wires the option
    // (no injected store to carry its own) and still serves normally.
    const onSaturated = vi.fn();
    const middleware = rateLimit({ capacity: 2, refillPerSecond: 1, onSaturated });

    const response = await middleware(request, async () => okResponse);

    expect(response.status).toBe(200);
  });
});

describe("rateLimit unresolved-client detection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires onUnknownClient once when an in-request IP cannot be resolved, not per request", async () => {
    const onUnknownClient = vi.fn();
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1, onUnknownClient });

    // Two in-request dispatches whose transport did not set ip: both fall back
    // to the shared bucket, but the warn-once latch keeps it to a single seam fire.
    await runWithContext({ requestId: "1" }, () => middleware(request, async () => okResponse));
    await runWithContext({ requestId: "2" }, () => middleware(request, async () => okResponse));

    expect(onUnknownClient).toHaveBeenCalledTimes(1);
  });

  it("does not fire onUnknownClient when dispatched outside any request context", async () => {
    // The build prerender / batch task path: no current context at all. Same
    // fallback bucket, but silent — there is no transport to misconfig, so the
    // warning would be noise. Separately covered by the bucket-touched test
    // above; this one pins the silence directly.
    const onUnknownClient = vi.fn();
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1, onUnknownClient });

    await middleware(request, async () => okResponse);
    await middleware(request, async () => okResponse);

    expect(onUnknownClient).not.toHaveBeenCalled();
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

    // Resolved first (no warning), then in-request with no ip (warns), then the
    // same again (warn-once latch holds). The latch is set only by a real
    // misconfig, so a resolved request in between does not reset it.
    await runWithContext({ requestId: "1", ip: "10.0.0.1" }, () =>
      middleware(request, async () => okResponse),
    );
    await runWithContext({ requestId: "2" }, () => middleware(request, async () => okResponse));
    await runWithContext({ requestId: "3" }, () => middleware(request, async () => okResponse));

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

    // In-request with no ip would normally warn — but an explicit key means
    // there is no unresolved fallback to detect.
    await runWithContext({ requestId: "1" }, () => middleware(request, async () => okResponse));

    expect(onUnknownClient).not.toHaveBeenCalled();
  });

  it("defaults to a coded console.warn when no onUnknownClient is injected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const middleware = rateLimit({ capacity: 5, refillPerSecond: 1 });

    await runWithContext({ requestId: "1" }, () => middleware(request, async () => okResponse));

    expect(warn).toHaveBeenCalledTimes(1);
    // Logs branch on the stable code, never the prose.
    expect(warn.mock.calls[0]?.[0]).toContain(RATELIMIT_UNKNOWN_CLIENT_CODE);
  });
});

describe("rateLimit onDenied seam", () => {
  it("fires onDenied with the coded kind and the throttled request on a 429", async () => {
    const onDenied = vi.fn();
    const limiter = fixedLimiter(1, 1);
    const middleware = rateLimit({ capacity: 1, refillPerSecond: 1, limiter, onDenied });

    // First request spends the only token (allowed); the second is throttled.
    expect((await middleware(request, async () => okResponse)).status).toBe(200);
    expect(onDenied).not.toHaveBeenCalled();

    const denied = await middleware(request, async () => okResponse);

    // The 429 (and its Retry-After) is unchanged — the hook only observes.
    expect(denied.status).toBe(429);
    expect(denied.headers["Retry-After"]).toBe("1");

    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied).toHaveBeenCalledWith(RATELIMIT_DENIED_KIND, request);
    expect(RATELIMIT_DENIED_KIND).toBe("ratelimit_exceeded");
  });

  it("awaits an async onDenied before answering the 429", async () => {
    const seen: string[] = [];
    const onDenied = async (kind: string): Promise<void> => {
      seen.push(kind);
    };
    const limiter = fixedLimiter(1, 1);
    const middleware = rateLimit({ capacity: 1, refillPerSecond: 1, limiter, onDenied });

    await middleware(request, async () => okResponse);
    const denied = await middleware(request, async () => okResponse);

    expect(denied.status).toBe(429);
    expect(seen).toEqual([RATELIMIT_DENIED_KIND]);
  });
});
