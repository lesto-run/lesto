import { describe, expect, it } from "vitest";

import { originCheck } from "../src/index";

import type { AnyKeelResponse, KeelRequest } from "@keel/web";

function requestWith(overrides: Partial<KeelRequest> = {}): KeelRequest {
  return {
    method: "POST",
    path: "/",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
}

const okResponse: AnyKeelResponse = { status: 200, headers: {}, body: "ok" };

const next = async (): Promise<AnyKeelResponse> => okResponse;

describe("originCheck middleware", () => {
  it("lets a safe (unguarded) method through without any origin evidence", async () => {
    const middleware = originCheck();

    expect((await middleware(requestWith({ method: "GET" }), next)).status).toBe(200);
  });

  it("allows a same-origin Sec-Fetch-Site with no configuration (zero-config)", async () => {
    const middleware = originCheck();

    const response = await middleware(
      requestWith({ headers: { "sec-fetch-site": "same-origin" } }),
      next,
    );

    expect(response.status).toBe(200);
  });

  it("allows a same-site initiator", async () => {
    const middleware = originCheck();

    expect(
      (await middleware(requestWith({ headers: { "sec-fetch-site": "same-site" } }), next)).status,
    ).toBe(200);
  });

  it("allows a user-initiated (none) request", async () => {
    const middleware = originCheck();

    expect(
      (await middleware(requestWith({ headers: { "sec-fetch-site": "none" } }), next)).status,
    ).toBe(200);
  });

  it("rejects a cross-site Sec-Fetch-Site with 403, case-insensitively", async () => {
    const middleware = originCheck();

    const response = await middleware(
      requestWith({ headers: { "sec-fetch-site": "Cross-Site" } }),
      next,
    );

    expect(response.status).toBe(403);
    expect(response.body).toBe("Forbidden");
  });

  it("falls back to an allowlisted Origin when Sec-Fetch-Site is absent", async () => {
    const middleware = originCheck({ allowedOrigins: ["https://app.example.com"] });

    const allowed = await middleware(
      requestWith({ headers: { origin: "https://app.example.com" } }),
      next,
    );

    expect(allowed.status).toBe(200);
  });

  it("rejects an Origin not on the allowlist", async () => {
    const middleware = originCheck({ allowedOrigins: ["https://app.example.com"] });

    const denied = await middleware(
      requestWith({ headers: { origin: "https://evil.example" } }),
      next,
    );

    expect(denied.status).toBe(403);
  });

  it("matches an allowed Origin case-insensitively", async () => {
    const middleware = originCheck({ allowedOrigins: ["https://App.Example.com"] });

    const response = await middleware(
      requestWith({ headers: { origin: "https://app.example.com" } }),
      next,
    );

    expect(response.status).toBe(200);
  });

  it("rejects an Origin fallback when no allowlist is configured (cannot vouch)", async () => {
    const middleware = originCheck();

    const response = await middleware(
      requestWith({ headers: { origin: "https://app.example.com" } }),
      next,
    );

    expect(response.status).toBe(403);
  });

  it("fails closed when neither Sec-Fetch-Site nor Origin is present", async () => {
    const middleware = originCheck();

    expect((await middleware(requestWith(), next)).status).toBe(403);
  });

  it("allows a no-evidence request when allowNoOrigin is set (token-authed API)", async () => {
    const middleware = originCheck({ allowNoOrigin: true });

    expect((await middleware(requestWith(), next)).status).toBe(200);
  });

  it("guards only the configured methods", async () => {
    const middleware = originCheck({ methods: ["DELETE"] });

    // POST is no longer guarded → a cross-site POST passes.
    const post = await middleware(
      requestWith({ method: "POST", headers: { "sec-fetch-site": "cross-site" } }),
      next,
    );

    expect(post.status).toBe(200);

    // DELETE is guarded → a cross-site DELETE is refused.
    const del = await middleware(
      requestWith({ method: "DELETE", headers: { "sec-fetch-site": "cross-site" } }),
      next,
    );

    expect(del.status).toBe(403);
  });
});
