import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createApi } from "../src/client";
import type { Api } from "../src/client";
import { ClientError } from "../src/errors";

interface Listing {
  id: string;
  title: string;
}

// A sample contract exercising responses, params, query, and bodies.
interface SampleApi {
  "GET /mls/saved": { response: { saved: Listing[] } };
  "GET /mls/listings/:id": { response: Listing };
  "GET /search": { response: Listing[]; query: { q: string; sort?: string } };
  "POST /mls/api/sign-out": { response: { ok: true } };
  "POST /mls/listings": { response: Listing; body: { title: string } };
  "PUT /mls/listings/:id": { response: Listing; body: { title: string } };
  "PATCH /mls/listings/:id": { response: Listing; body: { title?: string } };
  "DELETE /mls/listings/:id": { response: { deleted: number } };
}

/** A fetch double: records each call and returns a fresh Response from the factory. */
function makeFetch(factory: (url: string, init: RequestInit) => Response): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const seen = init ?? {};
    calls.push({ url, init: seen });

    return factory(url, seen);
  }) as typeof fetch;

  return { fn, calls };
}

/** A JSON 200 response. */
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("createApi — requests", () => {
  it("GETs a param-less route and returns the typed JSON body", async () => {
    const { fn, calls } = makeFetch(() => json({ saved: [{ id: "1", title: "A" }] }));
    const api = createApi<SampleApi>({ fetch: fn });

    const result = await api.get("/mls/saved");

    expect(result).toEqual({ saved: [{ id: "1", title: "A" }] });
    expect(calls[0]?.url).toBe("/mls/saved");
    expect(calls[0]?.init.method).toBe("GET");
    expectTypeOf(result).toEqualTypeOf<{ saved: Listing[] }>();
  });

  it("substitutes and URL-encodes path params", async () => {
    const { fn, calls } = makeFetch(() => json({ id: "a b", title: "T" }));
    const api = createApi<SampleApi>({ fetch: fn });

    const one = await api.get("/mls/listings/:id", { params: { id: "a b" } });

    expect(one).toEqual({ id: "a b", title: "T" });
    expect(calls[0]?.url).toBe("/mls/listings/a%20b");
    expectTypeOf(one).toEqualTypeOf<Listing>();
  });

  it("throws CLIENT_MISSING_PARAM when a :param has no value", async () => {
    const { fn } = makeFetch(() => json({}));
    const api = createApi<SampleApi>({ fetch: fn });

    // Cast through the erased shape: the public types forbid this at compile time,
    // but the runtime guard must still fire for a hand-built/JS caller.
    await expect(
      (api.get as (p: string, o: unknown) => Promise<unknown>)("/mls/listings/:id", {}),
    ).rejects.toMatchObject({ code: "CLIENT_MISSING_PARAM", details: { param: "id" } });
  });

  it("builds a query string and skips undefined values", async () => {
    const { fn, calls } = makeFetch(() => json([]));
    const api = createApi<SampleApi>({ fetch: fn });

    await api.get("/search", { query: { q: "homes", sort: undefined } });

    expect(calls[0]?.url).toBe("/search?q=homes");
  });

  it("emits no query string when every value is undefined", async () => {
    const { fn, calls } = makeFetch(() => json([]));
    const api = createApi<SampleApi>({ fetch: fn });

    await api.get("/search", { query: { q: undefined, sort: undefined } });

    expect(calls[0]?.url).toBe("/search");
  });

  it("uses the global fetch and option defaults when none are given", async () => {
    let sawUrl: string | undefined;
    vi.stubGlobal("fetch", (async (input: string | URL | Request) => {
      sawUrl = String(input);

      return json({ saved: [] });
    }) as typeof fetch);

    try {
      // No options at all: default baseUrl "", default headers {}, global fetch.
      const api = createApi<SampleApi>();

      expect(await api.get("/mls/saved")).toEqual({ saved: [] });
      expect(sawUrl).toBe("/mls/saved");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prepends the baseUrl and merges default + per-call headers", async () => {
    const { fn, calls } = makeFetch(() => json({ ok: true }));
    const api = createApi<SampleApi>({
      fetch: fn,
      baseUrl: "https://api.example.com",
      headers: { authorization: "Bearer t" },
    });

    await api.post("/mls/api/sign-out", { headers: { "x-trace": "1" } });

    expect(calls[0]?.url).toBe("https://api.example.com/mls/api/sign-out");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer t");
    expect(headers["x-trace"]).toBe("1");
  });

  it("JSON-encodes an object body and sets content-type", async () => {
    const { fn, calls } = makeFetch(() => json({ id: "1", title: "New" }, 201));
    const api = createApi<SampleApi>({ fetch: fn });

    const created = await api.post("/mls/listings", { body: { title: "New" } });

    expect(created).toEqual({ id: "1", title: "New" });
    expect(calls[0]?.init.body).toBe('{"title":"New"}');
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("sends a string body verbatim and never overrides a caller's content-type", async () => {
    const { fn, calls } = makeFetch(() => json({ id: "1", title: "x" }));
    const api = createApi<SampleApi>({ fetch: fn });

    await (api.put as (p: string, o: unknown) => Promise<unknown>)("/mls/listings/:id", {
      params: { id: "1" },
      body: "raw-payload",
      headers: { "content-type": "text/plain" },
    });

    expect(calls[0]?.init.body).toBe("raw-payload");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("text/plain");
  });

  it("forwards an AbortSignal when given, and omits it otherwise", async () => {
    const { fn, calls } = makeFetch(() => json({ id: "1", title: "x" }));
    const api = createApi<SampleApi>({ fetch: fn });

    const controller = new AbortController();
    await api.patch("/mls/listings/:id", {
      params: { id: "1" },
      body: { title: "z" },
      signal: controller.signal,
    });
    expect(calls[0]?.init.signal).toBe(controller.signal);

    await api.delete("/mls/listings/:id", { params: { id: "1" } });
    expect(calls[1]?.init.signal).toBeUndefined();
  });

  it("returns undefined for a 204 No Content", async () => {
    const { fn } = makeFetch(() => new Response(null, { status: 204 }));
    const api = createApi<SampleApi>({ fetch: fn });

    expect(await api.delete("/mls/listings/:id", { params: { id: "1" } })).toBeUndefined();
  });
});

describe("createApi — trace propagation (ARCHITECTURE.md §7)", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  it("stamps an outbound traceparent on a same-origin request when a trace is set", async () => {
    const { fn, calls } = makeFetch(() => json({ saved: [] }));

    const api = createApi<SampleApi>({
      fetch: fn,
      baseUrl: "https://app.test",
      trace: { traceId, origin: "https://app.test", randomSpanId: () => "aaaaaaaaaaaaaaaa" },
    });

    await api.get("/mls/saved");

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("traceparent")).toBe(`00-${traceId}-aaaaaaaaaaaaaaaa-01`);
  });

  it("never stamps a cross-origin request (no trace-id leak)", async () => {
    const { fn, calls } = makeFetch(() => json({ saved: [] }));

    const api = createApi<SampleApi>({
      fetch: fn,
      baseUrl: "https://api.other.test",
      trace: { traceId, origin: "https://app.test", randomSpanId: () => "aaaaaaaaaaaaaaaa" },
    });

    await api.get("/mls/saved");

    expect(new Headers(calls[0]?.init.headers).has("traceparent")).toBe(false);
  });

  it("defaults the origin and span-id generator when omitted (the browser-safe path)", async () => {
    const { fn, calls } = makeFetch(() => json({ saved: [] }));

    // No origin/randomSpanId: defaultOrigin() → localhost (no `location` in node),
    // defaultSpanId() → a crypto-backed 16-hex id. A same-origin request to the
    // localhost default carries a well-formed traceparent.
    const api = createApi<SampleApi>({
      fetch: fn,
      baseUrl: "http://localhost",
      trace: { traceId },
    });

    await api.get("/mls/saved");

    const traceparent = new Headers(calls[0]?.init.headers).get("traceparent");
    expect(traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
  });

  it("reads location.origin for the default same-origin gate when a browser `location` exists", async () => {
    const { fn, calls } = makeFetch(() => json({ saved: [] }));

    // A browser-like `location` makes defaultOrigin() read its origin (the non-node
    // branch). A request to that origin is then same-origin and carries the header.
    vi.stubGlobal("location", { origin: "https://browser.test" });

    try {
      const api = createApi<SampleApi>({
        fetch: fn,
        baseUrl: "https://browser.test",
        trace: { traceId, randomSpanId: () => "cccccccccccccccc" },
      });

      await api.get("/mls/saved");

      expect(new Headers(calls[0]?.init.headers).get("traceparent")).toBe(
        `00-${traceId}-cccccccccccccccc-01`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wraps the GLOBAL fetch when a trace is set but no fetch is injected", async () => {
    let sawUrl: string | undefined;
    let sawTraceparent: string | null = null;

    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      sawUrl = String(input);
      sawTraceparent = new Headers(init?.headers).get("traceparent");

      return json({ saved: [] });
    }) as typeof fetch);

    try {
      // No `fetch` option: the trace path must still wrap the GLOBAL fetch.
      const api = createApi<SampleApi>({
        baseUrl: "http://localhost",
        trace: { traceId, origin: "http://localhost", randomSpanId: () => "bbbbbbbbbbbbbbbb" },
      });

      await api.get("/mls/saved");

      expect(sawUrl).toBe("http://localhost/mls/saved");
      expect(sawTraceparent).toBe(`00-${traceId}-bbbbbbbbbbbbbbbb-01`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to Math.random for the span id when crypto is absent", async () => {
    const { fn, calls } = makeFetch(() => json({ saved: [] }));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("crypto", undefined);

    try {
      const api = createApi<SampleApi>({
        fetch: fn,
        baseUrl: "http://localhost",
        trace: { traceId },
      });

      await api.get("/mls/saved");

      const traceparent = new Headers(calls[0]?.init.headers).get("traceparent");
      expect(traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
      expect(randomSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      randomSpy.mockRestore();
    }
  });
});

describe("createApi — error path", () => {
  it("throws CLIENT_HTTP_ERROR with status + parsed JSON body on a non-2xx", async () => {
    const { fn } = makeFetch(() => json({ error: "nope" }, 401));
    const api = createApi<SampleApi>({ fetch: fn });

    await expect(api.get("/mls/saved")).rejects.toMatchObject({
      code: "CLIENT_HTTP_ERROR",
      details: { status: 401, body: { error: "nope" } },
    });
  });

  it("carries a non-JSON error body through as text", async () => {
    const { fn } = makeFetch(() => new Response("upstream exploded", { status: 502 }));
    const api = createApi<SampleApi>({ fetch: fn });

    const error = await api.get("/mls/saved").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).details).toMatchObject({
      status: 502,
      body: "upstream exploded",
    });
  });

  it("reports an empty error body as undefined", async () => {
    const { fn } = makeFetch(() => new Response("", { status: 500 }));
    const api = createApi<SampleApi>({ fetch: fn });

    await expect(api.get("/mls/saved")).rejects.toMatchObject({
      details: { status: 500, body: undefined },
    });
  });
});

describe("createApi — type inference", () => {
  it("constrains paths and infers responses (compile-time)", () => {
    // These are compile-time assertions only; the function is referenced but never
    // invoked, so no request actually fires (and no promise is left unhandled).
    const typeChecks = (api: Api<SampleApi>): void => {
      expectTypeOf(api.get("/mls/saved")).resolves.toEqualTypeOf<{ saved: Listing[] }>();
      expectTypeOf(
        api.delete("/mls/listings/:id", { params: { id: "1" } }),
      ).resolves.toEqualTypeOf<{ deleted: number }>();

      // A path the contract does not declare for the method is rejected.
      // @ts-expect-error — "/nope" is not a GET route in SampleApi.
      void api.get("/nope");

      // A `:param` path requires `params` — omitting the options is an error.
      // @ts-expect-error — params is required for "/mls/listings/:id".
      void api.get("/mls/listings/:id");
    };

    expect(typeof typeChecks).toBe("function");
  });
});
