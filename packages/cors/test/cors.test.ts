import { describe, expect, it } from "vitest";

import { corsHeaders, CorsError } from "../src/cors";

const DEFAULT_METHODS = "GET, HEAD, PUT, PATCH, POST, DELETE";

/** A predicate origin policy: allow any subdomain of `trusted.example`. */
const trustedSuffix = (origin: string): boolean => origin.endsWith(".trusted.example");

describe("corsHeaders — wildcard origin", () => {
  it("defaults to a wildcard policy when no options are given", () => {
    expect(corsHeaders("https://app.example.com")).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
    });
  });

  it("stays wildcard with an explicit `*` and no request origin", () => {
    expect(corsHeaders(undefined, { origin: "*" })).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
    });
  });

  it("rejects `*` combined with credentials — never reflects an arbitrary origin", () => {
    // The credentialed-CORS bypass: reflecting Origin with credentials lets any
    // site read authenticated responses. We fail loud at config time instead.
    expect(() =>
      corsHeaders("https://evil.example.com", { origin: "*", credentials: true }),
    ).toThrow(CorsError);

    try {
      corsHeaders("https://evil.example.com", { origin: "*", credentials: true });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CorsError);
      expect((error as CorsError).code).toBe("CORS_WILDCARD_WITH_CREDENTIALS");
    }
  });

  it("rejects the *default* (implicit `*`) origin combined with credentials", () => {
    // origin omitted defaults to "*", so the guard must fire here too.
    expect(() => corsHeaders("https://evil.example.com", { credentials: true })).toThrow(CorsError);
  });

  it("still allows a plain wildcard without credentials", () => {
    expect(corsHeaders("https://evil.example.com", { origin: "*", credentials: false })).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
    });
  });
});

describe("corsHeaders — single string origin", () => {
  it("echoes the origin and adds Vary when it matches exactly", () => {
    expect(corsHeaders("https://app.example.com", { origin: "https://app.example.com" })).toEqual({
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      Vary: "Origin",
    });
  });

  it("denies a non-matching origin but still varies on Origin (cache-safe deny)", () => {
    // The deny path must carry `Vary: Origin` under a non-wildcard policy, or a
    // shared cache could replay this empty deny over an allowed origin's hit.
    expect(corsHeaders("https://evil.example.com", { origin: "https://app.example.com" })).toEqual({
      Vary: "Origin",
    });
  });

  it("varies on Origin even when the request carries no origin (non-wildcard policy)", () => {
    expect(corsHeaders(undefined, { origin: "https://app.example.com" })).toEqual({
      Vary: "Origin",
    });
  });
});

describe("corsHeaders — array origin allow-list", () => {
  const allow = ["https://a.example.com", "https://b.example.com"];

  it("echoes a member origin and adds Vary", () => {
    expect(corsHeaders("https://b.example.com", { origin: allow })).toEqual({
      "Access-Control-Allow-Origin": "https://b.example.com",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      Vary: "Origin",
    });
  });

  it("denies a non-member origin but still varies on Origin", () => {
    expect(corsHeaders("https://c.example.com", { origin: allow })).toEqual({ Vary: "Origin" });
  });

  it("varies on Origin when the request has no origin (allow-list policy)", () => {
    expect(corsHeaders(undefined, { origin: allow })).toEqual({ Vary: "Origin" });
  });

  it("echoes a member origin WITH credentials, but never a non-member", () => {
    // Credentials are safe only against an explicit allow-list: members get
    // reflected, outsiders get nothing — no credentialed reflection of attackers.
    expect(corsHeaders("https://a.example.com", { origin: allow, credentials: true })).toEqual({
      "Access-Control-Allow-Origin": "https://a.example.com",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });

    // A non-member earns no Access-Control-* headers (no credentialed reflection)
    // but still carries Vary: Origin so the deny is not cached cross-origin.
    expect(corsHeaders("https://evil.example.com", { origin: allow, credentials: true })).toEqual({
      Vary: "Origin",
    });
  });
});

describe("corsHeaders — methods, headers, maxAge, credentials", () => {
  it("joins custom methods and headers, and emits maxAge", () => {
    expect(
      corsHeaders("https://app.example.com", {
        methods: ["GET", "POST"],
        headers: ["Content-Type", "Authorization"],
        maxAge: 600,
      }),
    ).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
    });
  });

  it("omits the headers and maxAge lines when those options are absent", () => {
    const result = corsHeaders("https://app.example.com", { credentials: false });

    expect(result).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
    });
    expect(result).not.toHaveProperty("Access-Control-Allow-Headers");
    expect(result).not.toHaveProperty("Access-Control-Max-Age");
    expect(result).not.toHaveProperty("Access-Control-Allow-Credentials");
  });

  it("emits the credentials header on an exact-match origin", () => {
    expect(
      corsHeaders("https://app.example.com", {
        origin: "https://app.example.com",
        credentials: true,
        maxAge: 0,
      }),
    ).toEqual({
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "0",
      Vary: "Origin",
    });
  });

  it("exposes response headers via Access-Control-Expose-Headers", () => {
    expect(
      corsHeaders("https://app.example.com", { exposeHeaders: ["X-Total-Count", "X-Request-Id"] }),
    ).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Expose-Headers": "X-Total-Count, X-Request-Id",
    });
  });
});

describe("corsHeaders — reflecting Access-Control-Request-Headers", () => {
  it("reflects the requested headers when no static allow-list is set (and varies on them)", () => {
    // The out-of-the-box preflight: a cross-origin JSON fetch announces
    // `content-type`. With no `headers` list configured we must echo it back, or
    // the browser blocks the real request. The value is request-derived, so the
    // response varies on `Access-Control-Request-Headers` even under wildcard.
    expect(corsHeaders("https://app.example.com", {}, "content-type")).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Headers": "content-type",
      Vary: "Access-Control-Request-Headers",
    });
  });

  it("prefers a static allow-list over reflection when one is configured", () => {
    // A configured list pins the surface: the requested value is ignored, and
    // the response no longer varies on it.
    expect(
      corsHeaders("https://app.example.com", { headers: ["Authorization"] }, "content-type"),
    ).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Headers": "Authorization",
    });
  });

  it("stacks Origin and Access-Control-Request-Headers in Vary under a non-wildcard policy", () => {
    expect(
      corsHeaders(
        "https://app.example.com",
        { origin: "https://app.example.com" },
        "content-type, x-custom",
      ),
    ).toEqual({
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Headers": "content-type, x-custom",
      Vary: "Origin, Access-Control-Request-Headers",
    });
  });

  it("reflects nothing for a denied origin, even when headers were requested", () => {
    // A denied origin earns no Access-Control-* headers at all — the reflection
    // never happens because the deny path returns before it.
    expect(
      corsHeaders(
        "https://evil.example.com",
        { origin: "https://app.example.com" },
        "content-type",
      ),
    ).toEqual({ Vary: "Origin" });
  });
});

describe("corsHeaders — RegExp and predicate origins", () => {
  it("echoes an origin a RegExp matches, and denies one it does not", () => {
    const policy = /^https:\/\/[a-z]+\.example\.com$/;

    expect(corsHeaders("https://app.example.com", { origin: policy })).toEqual({
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      Vary: "Origin",
    });

    expect(corsHeaders("https://app.evil.com", { origin: policy })).toEqual({ Vary: "Origin" });
  });

  it("gives a stateful /g RegExp the same verdict on repeated calls", () => {
    // A `/g` source carries a mutable `lastIndex`; reusing the caller's regex
    // would flip true/false on alternate requests. We match on a stateless copy,
    // so the same origin is allowed every time.
    const policy = /^https:\/\/app\.example\.com$/g;

    for (let i = 0; i < 3; i++) {
      expect(corsHeaders("https://app.example.com", { origin: policy })).toEqual({
        "Access-Control-Allow-Origin": "https://app.example.com",
        "Access-Control-Allow-Methods": DEFAULT_METHODS,
        Vary: "Origin",
      });
    }
  });

  it("echoes an origin a predicate approves, and denies one it rejects", () => {
    expect(
      corsHeaders("https://tenant.trusted.example", { origin: trustedSuffix, credentials: true }),
    ).toEqual({
      "Access-Control-Allow-Origin": "https://tenant.trusted.example",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });

    expect(corsHeaders("https://tenant.evil.example", { origin: trustedSuffix })).toEqual({
      Vary: "Origin",
    });
  });

  it("denies a RegExp or predicate policy when the request carries no origin", () => {
    expect(corsHeaders(undefined, { origin: /.*/ })).toEqual({ Vary: "Origin" });
    expect(corsHeaders(undefined, { origin: () => true })).toEqual({ Vary: "Origin" });
  });
});
