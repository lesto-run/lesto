import { afterEach, describe, expect, it, vi } from "vitest";

import { isPrivateAddress, nodePinningFetch, pinnedLookup, WebhookError } from "../src/index";

import type { HttpRequester, Resolver } from "../src/index";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

// node:http / node:https are mocked so the default requester (nodeRequester) can
// be driven without a socket — the spies stand in for the real `request`.
const { httpRequestSpy, httpsRequestSpy } = vi.hoisted(() => ({
  httpRequestSpy: vi.fn(),
  httpsRequestSpy: vi.fn(),
}));

vi.mock("node:http", () => ({ request: httpRequestSpy }));
vi.mock("node:https", () => ({ request: httpsRequestSpy }));

// A public address pair (example.com's real A / AAAA) and private spoilers.
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
const PRIVATE_V4 = "10.0.0.5";

/** A resolver that always returns the same set, with no DNS. */
function staticResolver(addresses: readonly string[]): Resolver {
  return async () => addresses;
}

/** A response whose `end` / `error` the test fires by hand, after handlers register. */
class FakeResponse {
  readonly statusCode: number | undefined;

  private endListener: (() => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;

  constructor(statusCode: number | undefined) {
    this.statusCode = statusCode;
  }

  resume(): void {}

  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end" | "error", listener: (() => void) | ((error: Error) => void)): this {
    if (event === "end") this.endListener = listener as () => void;
    else this.errorListener = listener as (error: Error) => void;

    return this;
  }

  emitEnd(): void {
    this.endListener?.();
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

/** A request handle that records the body it was written and fires `error` on demand. */
class FakeRequest {
  body = "";
  ended = false;

  private errorListener: ((error: Error) => void) | undefined;

  on(_event: "error", listener: (error: Error) => void): this {
    this.errorListener = listener;

    return this;
  }

  write(chunk: string): void {
    this.body += chunk;
  }

  end(): void {
    this.ended = true;
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

/** Drive a `LookupFunction` once and capture how it called back. */
function runLookup(
  lookup: LookupFunction,
  hostname: string,
  options: LookupOptions,
): Promise<{
  err: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family: number | undefined;
}> {
  return new Promise((resolve) => {
    lookup(hostname, options, (err, address, family) => {
      resolve({ err, address, family });
    });
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("pinnedLookup", () => {
  it("pins the first public address (single-address form)", async () => {
    const lookup = pinnedLookup(staticResolver([PUBLIC_V4]));

    const { err, address, family } = await runLookup(lookup, "example.com", {});

    expect(err).toBeNull();
    expect(address).toBe(PUBLIC_V4);
    expect(family).toBe(4);
  });

  it("returns the whole validated set when node asks for all (Happy-Eyeballs)", async () => {
    const lookup = pinnedLookup(staticResolver([PUBLIC_V4, PUBLIC_V6]));

    const { err, address } = await runLookup(lookup, "example.com", { all: true });

    expect(err).toBeNull();
    expect(address).toEqual([
      { address: PUBLIC_V4, family: 4 },
      { address: PUBLIC_V6, family: 6 },
    ]);
  });

  it("filters to the requested address family", async () => {
    const lookup = pinnedLookup(staticResolver([PUBLIC_V4, PUBLIC_V6]));

    const { address, family } = await runLookup(lookup, "example.com", { family: 6 });

    expect(address).toBe(PUBLIC_V6);
    expect(family).toBe(6);
  });

  it("fails the connect when no public address matches the requested family", async () => {
    const lookup = pinnedLookup(staticResolver([PUBLIC_V4]));

    const { err } = await runLookup(lookup, "example.com", { family: 6 });

    expect(err).toBeInstanceOf(WebhookError);
    expect((err as WebhookError).message).toContain("no public address for family 6");
  });

  it("fails the connect when the host does not resolve", async () => {
    const lookup = pinnedLookup(staticResolver([]));

    const { err } = await runLookup(lookup, "example.com", {});

    expect((err as WebhookError).code).toBe("WEBHOOK_URL_BLOCKED");
    expect((err as WebhookError).message).toContain("did not resolve");
  });

  it("fails closed when ANY resolved address is private (rebind defense)", async () => {
    const lookup = pinnedLookup(staticResolver([PUBLIC_V4, PRIVATE_V4]));

    const { err } = await runLookup(lookup, "example.com", {});

    expect((err as WebhookError).code).toBe("WEBHOOK_URL_BLOCKED");
    expect((err as WebhookError).message).toContain("private/reserved");
  });

  it("wraps a non-Error resolver rejection into a blocked-connect error", async () => {
    const lookup = pinnedLookup(() => Promise.reject("dns exploded"));

    const { err } = await runLookup(lookup, "example.com", {});

    expect((err as WebhookError).code).toBe("WEBHOOK_URL_BLOCKED");
    expect((err as WebhookError).message).toContain("dns exploded");
  });
});

describe("nodePinningFetch — delivery over an injected requester", () => {
  function setup(statusCode: number | undefined) {
    const response = new FakeResponse(statusCode);
    const request = new FakeRequest();

    let captured:
      | {
          url: string;
          method: string;
          headers: Record<string, string>;
          lookup: LookupFunction;
          signal: AbortSignal | undefined;
        }
      | undefined;

    const requester: HttpRequester = (url, options, onResponse) => {
      captured = {
        url,
        method: options.method,
        headers: options.headers,
        lookup: options.lookup,
        signal: options.signal,
      };
      onResponse(response);

      return request;
    };

    return { response, request, requester, captured: () => captured };
  }

  it("resolves ok=true for a 2xx and forwards method, headers, and body", async () => {
    const { response, request, requester, captured } = setup(200);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });
    const promise = fetchFn("https://example.com/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"hi":1}',
    });

    response.emitEnd();

    expect(await promise).toEqual({ ok: true, status: 200 });
    expect(captured()?.method).toBe("POST");
    expect(captured()?.headers).toEqual({ "content-type": "application/json" });
    expect(typeof captured()?.lookup).toBe("function");
    expect(request.body).toBe('{"hi":1}');
    expect(request.ended).toBe(true);
  });

  it("resolves ok=false for a non-2xx (a 3xx is a refused redirect)", async () => {
    const { response, requester } = setup(302);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });
    const promise = fetchFn("https://example.com/hook", {
      method: "POST",
      headers: {},
      body: "{}",
    });

    response.emitEnd();

    expect(await promise).toEqual({ ok: false, status: 302 });
  });

  it("treats a missing status code as 0 (not ok)", async () => {
    const { response, requester } = setup(undefined);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });
    const promise = fetchFn("https://example.com/hook", {
      method: "POST",
      headers: {},
      body: "{}",
    });

    response.emitEnd();

    expect(await promise).toEqual({ ok: false, status: 0 });
  });

  it("rejects when the request emits an error", async () => {
    const { request, requester } = setup(200);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });
    const promise = fetchFn("https://example.com/hook", {
      method: "POST",
      headers: {},
      body: "{}",
    });

    request.emitError(new Error("socket hang up"));

    await expect(promise).rejects.toThrow("socket hang up");
  });

  it("rejects when the response emits an error", async () => {
    const { response, requester } = setup(200);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });
    const promise = fetchFn("https://example.com/hook", {
      method: "POST",
      headers: {},
      body: "{}",
    });

    response.emitError(new Error("stream broke"));

    await expect(promise).rejects.toThrow("stream broke");
  });

  it("rejects an unparseable URL before connecting", async () => {
    const { requester } = setup(200);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });

    await expect(
      fetchFn("not a url", { method: "POST", headers: {}, body: "{}" }),
    ).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
  });

  it("rejects a non-http(s) scheme before connecting", async () => {
    const { requester } = setup(200);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });

    await expect(
      fetchFn("ftp://example.com/x", { method: "POST", headers: {}, body: "{}" }),
    ).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED" });
  });

  it("hands the requester a lookup that itself enforces the public-only pin", async () => {
    const { response, requester, captured } = setup(200);

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PRIVATE_V4]) });
    const promise = fetchFn("https://internal.example/hook", {
      method: "POST",
      headers: {},
      body: "{}",
    });

    response.emitEnd();
    await promise;

    // The connect would have been refused: drive the captured lookup directly.
    const lookup = captured()?.lookup;
    expect(lookup).toBeDefined();

    const { err } = await runLookup(lookup as LookupFunction, "internal.example", {});
    expect((err as WebhookError).code).toBe("WEBHOOK_URL_BLOCKED");
    expect(isPrivateAddress(PRIVATE_V4)).toBe(true);
  });

  it("forwards the delivery deadline signal to the requester (so an abort can destroy the socket)", async () => {
    const { response, requester, captured } = setup(200);
    const controller = new AbortController();

    const fetchFn = nodePinningFetch({ requester, resolver: staticResolver([PUBLIC_V4]) });
    const promise = fetchFn("https://example.com/hook", {
      method: "POST",
      headers: {},
      body: "{}",
      signal: controller.signal,
    });

    response.emitEnd();
    await promise;

    // The deliverer's `AbortSignal.timeout` deadline must reach node's request
    // options — a signal the transport ignores is inert, and a hung POST would
    // never be aborted. The default requester passes it to node's `http.request`,
    // whose abort destroys the socket.
    expect(captured()?.signal).toBe(controller.signal);
  });
});

describe("nodePinningFetch — default node:http(s) requester", () => {
  it("dispatches an https URL to node:https", async () => {
    const response = new FakeResponse(200);
    const request = new FakeRequest();

    httpsRequestSpy.mockImplementation(
      (_url: string, _options: unknown, cb: (res: FakeResponse) => void) => {
        cb(response);

        return request;
      },
    );

    const fetchFn = nodePinningFetch();
    const promise = fetchFn("https://example.com/hook", {
      method: "POST",
      headers: {},
      body: "{}",
    });

    response.emitEnd();

    expect(await promise).toEqual({ ok: true, status: 200 });
    expect(httpsRequestSpy).toHaveBeenCalledOnce();
    expect(httpRequestSpy).not.toHaveBeenCalled();
  });

  it("dispatches an http URL to node:http", async () => {
    const response = new FakeResponse(204);
    const request = new FakeRequest();

    httpRequestSpy.mockImplementation(
      (_url: string, _options: unknown, cb: (res: FakeResponse) => void) => {
        cb(response);

        return request;
      },
    );

    const fetchFn = nodePinningFetch();
    const promise = fetchFn("http://example.com/hook", { method: "POST", headers: {}, body: "{}" });

    response.emitEnd();

    expect(await promise).toEqual({ ok: true, status: 204 });
    expect(httpRequestSpy).toHaveBeenCalledOnce();
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });
});
