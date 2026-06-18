import { describe, expect, it, vi } from "vitest";

import { ORIGIN_DENIED_KIND, ORIGIN_STRICT_DENIED_KIND, originCheck } from "../src/index";

import type { AnyLestoResponse, LestoRequest } from "@lesto/web";

function requestWith(overrides: Partial<LestoRequest> = {}): LestoRequest {
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

const okResponse: AnyLestoResponse = { status: 200, headers: {}, body: "ok" };

const next = async (): Promise<AnyLestoResponse> => okResponse;

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

describe("originCheck — strict (same-origin) mode", () => {
  it("allows a same-origin Sec-Fetch-Site", async () => {
    const middleware = originCheck({ strict: true });

    expect(
      (await middleware(requestWith({ headers: { "sec-fetch-site": "same-origin" } }), next))
        .status,
    ).toBe(200);
  });

  it("refuses a same-site initiator that the default would have allowed", async () => {
    const middleware = originCheck({ strict: true });

    // same-site passes in the default posture; strict requires same-origin.
    const response = await middleware(
      requestWith({ headers: { "sec-fetch-site": "same-site" } }),
      next,
    );

    expect(response.status).toBe(403);
  });

  it("refuses a 'none' initiator under strict (only same-origin is trusted)", async () => {
    const middleware = originCheck({ strict: true });

    expect(
      (await middleware(requestWith({ headers: { "sec-fetch-site": "none" } }), next)).status,
    ).toBe(403);
  });

  it("matches Sec-Fetch-Site case-insensitively in strict mode", async () => {
    const middleware = originCheck({ strict: true });

    expect(
      (await middleware(requestWith({ headers: { "sec-fetch-site": "Same-Origin" } }), next))
        .status,
    ).toBe(200);
  });

  it("uses the allow-list as the same-origin set on the Origin fallback", async () => {
    const middleware = originCheck({ strict: true, allowedOrigins: ["https://app.example.com"] });

    const allowed = await middleware(
      requestWith({ headers: { origin: "https://app.example.com" } }),
      next,
    );
    expect(allowed.status).toBe(200);

    const denied = await middleware(
      requestWith({ headers: { origin: "https://other.example.com" } }),
      next,
    );
    expect(denied.status).toBe(403);
  });
});

describe("originCheck — onDenied seam", () => {
  it("fires onDenied with the cross-site coded kind and the refused request", async () => {
    const onDenied = vi.fn();
    const middleware = originCheck({ onDenied });

    const request = requestWith({ headers: { "sec-fetch-site": "cross-site" } });
    const response = await middleware(request, next);

    expect(response.status).toBe(403);
    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied).toHaveBeenCalledWith(ORIGIN_DENIED_KIND, request);
    expect(ORIGIN_DENIED_KIND).toBe("origin_cross_site");
  });

  it("fires onDenied with the STRICT coded kind on a same-site refusal", async () => {
    const onDenied = vi.fn();
    const middleware = originCheck({ strict: true, onDenied });

    const request = requestWith({ headers: { "sec-fetch-site": "same-site" } });
    const response = await middleware(request, next);

    expect(response.status).toBe(403);
    expect(onDenied).toHaveBeenCalledWith(ORIGIN_STRICT_DENIED_KIND, request);
    expect(ORIGIN_STRICT_DENIED_KIND).toBe("origin_not_same_origin");
  });

  it("fires onDenied on an un-allowlisted Origin fallback", async () => {
    const onDenied = vi.fn();
    const middleware = originCheck({ allowedOrigins: ["https://app.example.com"], onDenied });

    const request = requestWith({ headers: { origin: "https://evil.example" } });
    await middleware(request, next);

    expect(onDenied).toHaveBeenCalledWith(ORIGIN_DENIED_KIND, request);
  });

  it("awaits an async onDenied, and fires on the no-evidence refusal too", async () => {
    const seen: string[] = [];
    const onDenied = async (kind: string): Promise<void> => {
      seen.push(kind);
    };
    const middleware = originCheck({ onDenied });

    const response = await middleware(requestWith(), next);

    expect(response.status).toBe(403);
    expect(seen).toEqual([ORIGIN_DENIED_KIND]);
  });

  it("never fires onDenied on an allowed request", async () => {
    const onDenied = vi.fn();
    const middleware = originCheck({ onDenied });

    const response = await middleware(
      requestWith({ headers: { "sec-fetch-site": "same-origin" } }),
      next,
    );

    expect(response.status).toBe(200);
    expect(onDenied).not.toHaveBeenCalled();
  });
});
