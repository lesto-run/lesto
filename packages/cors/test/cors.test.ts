import { describe, expect, it } from "vitest";

import { corsHeaders, CorsError } from "../src/cors";

const DEFAULT_METHODS = "GET, HEAD, PUT, PATCH, POST, DELETE";

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
});
