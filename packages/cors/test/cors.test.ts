import { describe, expect, it } from "vitest";

import { corsHeaders } from "../src/cors";

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

  it("echoes the request origin when `*` is combined with credentials", () => {
    // "*" + credentials is invalid per Fetch, so we reflect the caller instead.
    expect(corsHeaders("https://app.example.com", { origin: "*", credentials: true })).toEqual({
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });
  });

  it("falls back to `*` under credentials when the request has no origin", () => {
    expect(corsHeaders(undefined, { origin: "*", credentials: true })).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Credentials": "true",
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

  it("returns no headers when the origin does not match", () => {
    expect(corsHeaders("https://evil.example.com", { origin: "https://app.example.com" })).toEqual(
      {},
    );
  });

  it("returns no headers when the request has no origin", () => {
    expect(corsHeaders(undefined, { origin: "https://app.example.com" })).toEqual({});
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

  it("returns no headers for a non-member origin", () => {
    expect(corsHeaders("https://c.example.com", { origin: allow })).toEqual({});
  });

  it("returns no headers when the request has no origin", () => {
    expect(corsHeaders(undefined, { origin: allow })).toEqual({});
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
