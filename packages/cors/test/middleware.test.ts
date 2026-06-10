import { describe, expect, it } from "vitest";

import { cors } from "../src/index";

import type { AnyKeelResponse, KeelRequest } from "@keel/web";

function requestWith(overrides: Partial<KeelRequest> = {}): KeelRequest {
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

const okResponse: AnyKeelResponse = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: "{}",
};

describe("cors middleware", () => {
  it("answers an OPTIONS preflight with 204 and the policy headers", async () => {
    let dispatched = false;

    const middleware = cors({ origin: "https://app.example.com" });

    const response = await middleware(
      requestWith({ method: "OPTIONS", headers: { origin: "https://app.example.com" } }),
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
