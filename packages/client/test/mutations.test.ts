import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createMutationClient, MUTATION_ROUTE_PREFIX } from "../src/mutations";
import type { MutationContract, MutationResult } from "../src/mutations";

// A sample mutation contract — the shape `MutationContractOf<typeof defs>` projects.
interface SampleMutations extends MutationContract {
  renameListing: { input: { id: string; name: string }; output: { listing: { id: string } } };
  ping: { input: undefined; output: { pong: true } };
}

/** A fetch double: records each call and returns a fresh Response from the factory. */
function makeFetch(factory: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const seen = init ?? {};
    calls.push({ url: String(input), init: seen });

    return factory(String(input), seen);
  }) as typeof fetch;

  return { fn, calls };
}

/** A JSON response at a given status. */
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("createMutationClient — the typed call side", () => {
  it("POSTs the input to /__lesto/mutations/:name and returns the success arm", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "3" } } }));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "3", name: "New" });

    expect(result).toEqual({ ok: true, data: { listing: { id: "3" } } });
    expect(calls[0]?.url).toBe(`${MUTATION_ROUTE_PREFIX}/renameListing`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ id: "3", name: "New" });

    // End-to-end inference: the data arm is the contract's output, narrowed by `ok`.
    if (result.ok) expectTypeOf(result.data).toEqualTypeOf<{ listing: { id: string } }>();
  });

  it("returns the failure arm verbatim for a non-2xx result body (no throw)", async () => {
    const failure = { ok: false, error: { code: "MUTATION_INVALID_INPUT", message: "bad" } };
    const { fn } = makeFetch(() => json(failure, 422));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "", name: "" });

    expect(result).toEqual(failure);
    if (!result.ok) expect(result.error.code).toBe("MUTATION_INVALID_INPUT");
  });

  it("attaches the configured CSRF token on the x-csrf-token header", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn, csrfToken: "tok.sig" });

    await mutate.renameListing({ id: "1", name: "A" });

    expect(new Headers(calls[0]?.init.headers).get("x-csrf-token")).toBe("tok.sig");
  });

  it("omits the CSRF header when no token is configured", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    await mutate.renameListing({ id: "1", name: "A" });

    expect(new Headers(calls[0]?.init.headers).has("x-csrf-token")).toBe(false);
  });

  it("merges base headers and prepends the baseUrl", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    const mutate = createMutationClient<SampleMutations>({
      fetch: fn,
      baseUrl: "https://api.example.com",
      headers: { authorization: "Bearer x" },
    });

    await mutate.renameListing({ id: "1", name: "A" });

    expect(calls[0]?.url).toBe(`https://api.example.com${MUTATION_ROUTE_PREFIX}/renameListing`);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer x");
  });

  it("sends `null` as the body for a no-arg mutation (and the input arg is optional)", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { pong: true } }));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.ping();

    expect(JSON.parse(String(calls[0]?.init.body))).toBeNull();
    if (result.ok) expectTypeOf(result.data).toEqualTypeOf<{ pong: true }>();
  });

  it("surfaces a transport failure (rejected fetch) as a coded failure arm", async () => {
    const fn = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    expect(result).toEqual({
      ok: false,
      error: { code: "MUTATION_TRANSPORT_FAILED", message: "network down" },
    });
  });

  it("surfaces a non-Error rejection with a default transport message", async () => {
    const fn = (() => Promise.reject("boom")) as unknown as typeof fetch;
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) {
      expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
      expect(result.error.message).toBe("Mutation request failed.");
    }
  });

  it("coerces a non-JSON answer into a transport failure carrying the status", async () => {
    const { fn } = makeFetch(() => new Response("<html>502</html>", { status: 502 }));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) {
      expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
      expect(result.error.message).toContain("502");
    }
  });

  it("coerces an empty-body answer into a transport failure", async () => {
    // A 200 with a genuinely empty body — `response.text()` reads `""`, the empty
    // branch in readJson (a server should always shape the union, so this is the
    // honest "unexpected response" case).
    const { fn } = makeFetch(() => new Response("", { status: 200 }));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
  });

  it("coerces a malformed result shape (ok present but no data/error) to a transport failure", async () => {
    const { fn } = makeFetch(() => json({ ok: true }, 200));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
  });

  it("coerces a failure arm missing a string code to a transport failure", async () => {
    const { fn } = makeFetch(() => json({ ok: false, error: { code: 42 } }, 400));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
  });

  it("coerces a non-object JSON answer to a transport failure", async () => {
    const { fn } = makeFetch(() => json("just a string", 200));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
  });

  it("coerces a failure arm whose `error` is not an object to a transport failure", async () => {
    const { fn } = makeFetch(() => json({ ok: false, error: "nope" }, 400));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
  });

  it("coerces a body whose `ok` is neither true nor false to a transport failure", async () => {
    const { fn } = makeFetch(() => json({ ok: "maybe" }, 200));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
  });

  it("coerces a failure arm whose error.code is absent to a transport failure", async () => {
    const { fn } = makeFetch(() => json({ ok: false, error: {} }, 400));
    const mutate = createMutationClient<SampleMutations>({ fetch: fn });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) expect(result.error.code).toBe("MUTATION_TRANSPORT_FAILED");
  });

  it("returns undefined for a symbol property access (not mistaken for a thenable)", () => {
    const mutate = createMutationClient<SampleMutations>({ fetch: vi.fn() });

    // A `then`-as-symbol probe and any symbol key resolve to undefined, so the
    // proxy is never awaited as if it were itself a promise.
    expect((mutate as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });
});

describe("createMutationClient — the global fetch fallback", () => {
  it("uses the GLOBAL fetch when none is injected (no trace)", async () => {
    let sawUrl: string | undefined;

    vi.stubGlobal("fetch", (async (input: string | URL | Request) => {
      sawUrl = String(input);

      return json({ ok: true, data: { listing: { id: "1" } } });
    }) as typeof fetch);

    try {
      const mutate = createMutationClient<SampleMutations>({});
      const result = await mutate.renameListing({ id: "1", name: "A" });

      expect(sawUrl).toBe(`${MUTATION_ROUTE_PREFIX}/renameListing`);
      expect(result.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wraps the GLOBAL fetch when a trace is set but no fetch is injected", async () => {
    let sawTraceparent: string | null = null;

    vi.stubGlobal("fetch", (async (_input: string | URL | Request, init?: RequestInit) => {
      sawTraceparent = new Headers(init?.headers).get("traceparent");

      return json({ ok: true, data: { listing: { id: "1" } } });
    }) as typeof fetch);

    try {
      const mutate = createMutationClient<SampleMutations>({
        baseUrl: "http://localhost",
        trace: {
          traceId: "2".repeat(32),
          origin: "http://localhost",
          randomSpanId: () => "b".repeat(16),
        },
      });

      await mutate.renameListing({ id: "1", name: "A" });

      expect(sawTraceparent).toBe(`00-${"2".repeat(32)}-${"b".repeat(16)}-01`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createMutationClient — trace propagation (ARCHITECTURE.md §7)", () => {
  it("wraps fetch so a same-origin mutation carries an outbound traceparent", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    const mutate = createMutationClient<SampleMutations>({
      fetch: fn,
      baseUrl: "http://localhost",
      trace: {
        traceId: "0".repeat(32),
        origin: "http://localhost",
        randomSpanId: () => "a".repeat(16),
      },
    });

    await mutate.renameListing({ id: "1", name: "A" });

    const traceparent = new Headers(calls[0]?.init.headers).get("traceparent");
    expect(traceparent).toBe(`00-${"0".repeat(32)}-${"a".repeat(16)}-01`);
  });

  it("uses the crypto/location defaults when trace origin + span id are omitted", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    // Off-browser: defaultOrigin() falls back to http://localhost; defaultSpanId()
    // uses crypto.getRandomValues (present under node:test) for a 16-hex span id.
    const mutate = createMutationClient<SampleMutations>({
      fetch: fn,
      baseUrl: "http://localhost",
      trace: { traceId: "1".repeat(32) },
    });

    await mutate.renameListing({ id: "1", name: "A" });

    const traceparent = new Headers(calls[0]?.init.headers).get("traceparent");
    expect(traceparent).toMatch(new RegExp(`^00-${"1".repeat(32)}-[0-9a-f]{16}-01$`));
  });
});

describe("createMutationClient — internalized CSRF round-trip (fetchCsrfToken)", () => {
  it("fetches the token itself and attaches it, sharing ONE round-trip across calls", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    let csrfFetches = 0;
    const fetchCsrfToken = async (): Promise<string> => {
      csrfFetches += 1;

      return "fetched.tok";
    };

    const mutate = createMutationClient<SampleMutations>({ fetch: fn, fetchCsrfToken });

    // Two concurrent submits + a later one — all share the single cached fetch.
    await Promise.all([
      mutate.renameListing({ id: "1", name: "A" }),
      mutate.renameListing({ id: "2", name: "B" }),
    ]);
    await mutate.renameListing({ id: "3", name: "C" });

    expect(csrfFetches).toBe(1);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("x-csrf-token")).toBe("fetched.tok");
    }
  });

  it("lets an explicit csrfToken win — fetchCsrfToken is never called", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    let csrfFetches = 0;
    const fetchCsrfToken = async (): Promise<string> => {
      csrfFetches += 1;

      return "fetched.tok";
    };

    const mutate = createMutationClient<SampleMutations>({
      fetch: fn,
      csrfToken: "explicit.tok",
      fetchCsrfToken,
    });

    await mutate.renameListing({ id: "1", name: "A" });

    expect(csrfFetches).toBe(0);
    expect(new Headers(calls[0]?.init.headers).get("x-csrf-token")).toBe("explicit.tok");
  });

  it("maps a rejecting fetch to a coded failure arm, clears the cache, and retries next call", async () => {
    const { fn } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));
    let csrfFetches = 0;
    const fetchCsrfToken = async (): Promise<string> => {
      csrfFetches += 1;

      if (csrfFetches === 1) throw new Error("csrf endpoint 500");

      return "recovered.tok";
    };

    const mutate = createMutationClient<SampleMutations>({ fetch: fn, fetchCsrfToken });

    const first = await mutate.renameListing({ id: "1", name: "A" });

    expect(first).toEqual({
      ok: false,
      error: { code: "MUTATION_CSRF_FETCH_FAILED", message: "csrf endpoint 500" },
    });

    // The cache was cleared, so the second submit RETRIES the fetch and succeeds.
    const second = await mutate.renameListing({ id: "1", name: "A" });

    expect(csrfFetches).toBe(2);
    expect(second.ok).toBe(true);
  });

  it("uses a default message when fetchCsrfToken rejects with a non-Error", async () => {
    const { fn } = makeFetch(() => json({ ok: true, data: { listing: { id: "1" } } }));

    const mutate = createMutationClient<SampleMutations>({
      fetch: fn,
      fetchCsrfToken: () => Promise.reject("nope"),
    });

    const result = await mutate.renameListing({ id: "1", name: "A" });

    if (!result.ok) {
      expect(result.error.code).toBe("MUTATION_CSRF_FETCH_FAILED");
      expect(result.error.message).toBe("CSRF token fetch failed.");
    }
  });
});

describe("MutationResult — the discriminated union", () => {
  it("narrows on `ok` to the data arm or the error arm", () => {
    const result = { ok: true, data: 5 } as MutationResult<number>;

    if (result.ok) expectTypeOf(result.data).toEqualTypeOf<number>();
    else expectTypeOf(result.error).toEqualTypeOf<{ code: string; message: string }>();
  });
});
