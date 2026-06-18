import { describe, expect, it } from "vitest";

import { cors } from "../src/index";

import type { AnyVoloResponse, VoloRequest } from "@volo/web";

function requestWith(overrides: Partial<VoloRequest> = {}): VoloRequest {
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

const okResponse: AnyVoloResponse = {
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
});
