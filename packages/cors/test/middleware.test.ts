import { describe, expect, it } from "vitest";

import { cors } from "../src/index";

import type { AnyLestoResponse, LestoRequest } from "@lesto/web";

function requestWith(overrides: Partial<LestoRequest> = {}): LestoRequest {
  return {
    method: "GET",
    path: "/",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
}

const okResponse: AnyLestoResponse = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: "{}",
};

describe("cors middleware", () => {
  it("answers an OPTIONS preflight with 204 and the policy headers", async () => {
    let dispatched = false;

    const middleware = cors({ origin: "https://app.example.com" });

    const response = await middleware(
      requestWith({
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          // The header that MAKES it a preflight — the method the real request will use.
          "access-control-request-method": "POST",
        },
      }),
      async () => {
        dispatched = true;
        return okResponse;
      },
    );

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
    // A preflight never reaches the inner stack.
    expect(dispatched).toBe(false);
  });

  it("lets a bare OPTIONS (no Access-Control-Request-Method) fall through to the controller", async () => {
    let dispatched = false;

    const middleware = cors({ origin: "*" });

    // An OPTIONS without the request-method header is NOT a preflight — it is an
    // ordinary OPTIONS the app may handle itself, so it must reach the stack.
    const response = await middleware(
      requestWith({ method: "OPTIONS", headers: { origin: "https://anywhere.example" } }),
      async () => {
        dispatched = true;
        return okResponse;
      },
    );

    expect(dispatched).toBe(true);
    expect(response.status).toBe(200);
    // The CORS policy is still advertised on the passed-through response.
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("merges the CORS headers under a real response, controller headers winning", async () => {
    const middleware = cors({ origin: "*" });

    const response = await middleware(
      requestWith({ method: "GET", headers: { origin: "https://anywhere.example" } }),
      async () => okResponse,
    );

    expect(response.status).toBe(200);
    // The controller's own header survives the merge.
    expect(response.headers["content-type"]).toBe("application/json");
    // ...and the wildcard CORS header is advertised.
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("token-unions a controller Vary with the policy Vary: Origin instead of clobbering it", async () => {
    // Non-wildcard policy → corsHeaders emits `Vary: Origin`. A controller that
    // sets its own `Vary: Cookie` must NOT drop `Origin`: last-writer-wins here
    // would reopen the shared-cache cross-origin leak.
    const middleware = cors({ origin: "https://app.example.com" });

    const response = await middleware(
      requestWith({ method: "GET", headers: { origin: "https://app.example.com" } }),
      async () => ({ ...okResponse, headers: { ...okResponse.headers, Vary: "Cookie" } }),
    );

    const tokens = String(response.headers["Vary"])
      .split(",")
      .map((token) => token.trim().toLowerCase());

    expect(tokens).toContain("origin");
    expect(tokens).toContain("cookie");
    // A single canonical Vary key — the union is not split across two casings.
    const varyKeys = Object.keys(response.headers).filter((key) => key.toLowerCase() === "vary");
    expect(varyKeys).toHaveLength(1);
  });

  it("keeps the policy Vary: Origin when the controller sets no Vary", async () => {
    const middleware = cors({ origin: "https://app.example.com" });

    const response = await middleware(
      requestWith({ method: "GET", headers: { origin: "https://app.example.com" } }),
      async () => okResponse,
    );

    expect(response.headers["Vary"]).toBe("Origin");
  });

  it("lets a controller header override a CORS header of the same name", async () => {
    const middleware = cors({ origin: "*" });

    const response = await middleware(requestWith({ method: "GET" }), async () => ({
      ...okResponse,
      headers: { "Access-Control-Allow-Origin": "https://override.example" },
    }));

    // Merged *under*, so the inner response's value wins.
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("https://override.example");
  });

  it("adds nothing for a denied origin, passing the response through", async () => {
    const middleware = cors({ origin: ["https://allowed.example"] });

    const response = await middleware(
      requestWith({ method: "GET", headers: { origin: "https://evil.example" } }),
      async () => okResponse,
    );

    expect(response.status).toBe(200);
    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("defaults to the wildcard policy when no options are passed", async () => {
    const middleware = cors();

    const response = await middleware(requestWith({ method: "GET" }), async () => okResponse);

    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("reflects Access-Control-Request-Headers on a preflight with the default policy", async () => {
    // The out-of-the-box case: a cross-origin JSON fetch sends `Content-Type:
    // application/json`, which forces a preflight tagged with
    // `Access-Control-Request-Headers: content-type`. With no static allow-list
    // the default policy must reflect that list back, or the browser blocks the
    // real request for want of an `Access-Control-Allow-Headers`.
    const middleware = cors();

    const response = await middleware(
      requestWith({
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
      async () => okResponse,
    );

    expect(response.status).toBe(204);
    expect(response.headers["Access-Control-Allow-Headers"]).toBe("content-type");
  });
});
