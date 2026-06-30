import { describe, expect, it } from "vitest";

import {
  assertDevToken,
  gateDevRequest,
  headerValue,
  isHostAllowed,
  isLiveReloadUpgradeAllowed,
  loopbackAllowlist,
  MIN_DEV_TOKEN_LENGTH,
  nodeHeadersToWeb,
  parseDevBody,
} from "../src/http-transport";

import type { DevMcpSecurity } from "../src/http-transport";

const port = 4321;
const { allowedOrigins, allowedHosts } = loopbackAllowlist(port);

const security: DevMcpSecurity = { token: "session-token", allowedOrigins, allowedHosts };

// A request that passes every gate — overridden per case.
const ok = {
  origin: undefined,
  host: `127.0.0.1:${port}`,
  token: "session-token",
  security,
};

describe("loopbackAllowlist", () => {
  it("lists 127.0.0.1 and localhost hosts + their http/https origins", () => {
    expect(allowedHosts).toEqual(["127.0.0.1:4321", "localhost:4321"]);
    expect(allowedOrigins).toEqual([
      "http://127.0.0.1:4321",
      "https://127.0.0.1:4321",
      "http://localhost:4321",
      "https://localhost:4321",
    ]);
  });
});

describe("isHostAllowed", () => {
  it("refuses an absent Host (every real HTTP request carries one)", () => {
    expect(isHostAllowed(undefined, allowedHosts)).toBe(false);
  });

  it("refuses a foreign Host and allows a loopback Host", () => {
    expect(isHostAllowed("evil.example:4321", allowedHosts)).toBe(false);
    expect(isHostAllowed("localhost:4321", allowedHosts)).toBe(true);
  });
});

describe("request shaping", () => {
  it("headerValue takes the first of a repeated header, passes a string, and forwards undefined", () => {
    expect(headerValue("one")).toBe("one");
    expect(headerValue(["a", "b"])).toBe("a");
    expect(headerValue(undefined)).toBeUndefined();
  });

  it("nodeHeadersToWeb skips undefined values and expands repeated headers", () => {
    const web = nodeHeadersToWeb({
      host: "127.0.0.1:1",
      absent: undefined,
      "set-cookie": ["a", "b"],
    });

    expect(web.get("host")).toBe("127.0.0.1:1");
    expect(web.has("absent")).toBe(false);
    expect(web.get("set-cookie")).toBe("a, b");
  });

  it("parseDevBody yields undefined for empty/malformed and the value for valid JSON", () => {
    expect(parseDevBody("")).toBeUndefined();
    expect(parseDevBody("{not json")).toBeUndefined();
    expect(parseDevBody('{"jsonrpc":"2.0"}')).toEqual({ jsonrpc: "2.0" });
  });
});

describe("gateDevRequest", () => {
  it("accepts a loopback request with the right token", () => {
    expect(gateDevRequest(ok)).toEqual({ kind: "accept" });
    expect(gateDevRequest({ ...ok, origin: "http://localhost:4321" })).toEqual({ kind: "accept" });
  });

  it("rejects a foreign Origin with MCP_DEV_ORIGIN_REJECTED before any token check", () => {
    const decision = gateDevRequest({ ...ok, origin: "https://evil.example" });

    expect(decision).toEqual({
      kind: "reject",
      status: 403,
      code: "MCP_DEV_ORIGIN_REJECTED",
      reason: "a foreign Origin",
    });
  });

  it("rejects a foreign Host", () => {
    const decision = gateDevRequest({ ...ok, host: "evil.example:4321" });

    expect(decision).toMatchObject({ kind: "reject", code: "MCP_DEV_ORIGIN_REJECTED" });
    expect(decision).toMatchObject({ reason: "a foreign Host" });
  });

  it("rejects a missing or wrong session token even on a clean loopback request", () => {
    expect(gateDevRequest({ ...ok, token: undefined })).toMatchObject({
      code: "MCP_DEV_ORIGIN_REJECTED",
      reason: "a missing or wrong session token",
    });
    // A different-LENGTH wrong token short-circuits before the constant-time compare.
    expect(gateDevRequest({ ...ok, token: "guessed" })).toMatchObject({
      reason: "a missing or wrong session token",
    });
    // A SAME-length wrong token exercises the constant-time compare itself returning false.
    expect(gateDevRequest({ ...ok, token: "session-tokeX" })).toMatchObject({
      reason: "a missing or wrong session token",
    });
  });
});

describe("assertDevToken", () => {
  it("accepts a token at or above the minimum length", () => {
    expect(() => assertDevToken("x".repeat(MIN_DEV_TOKEN_LENGTH))).not.toThrow();
  });

  it("rejects an empty or too-short token with MCP_DEV_TOKEN_REQUIRED", () => {
    for (const weak of ["", "x".repeat(MIN_DEV_TOKEN_LENGTH - 1)]) {
      let caught: unknown;

      try {
        assertDevToken(weak);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "MCP_DEV_TOKEN_REQUIRED" });
    }
  });
});

describe("isLiveReloadUpgradeAllowed", () => {
  const reloadPort = 35729;

  it("allows a loopback page (127.0.0.1 / localhost) on ANY port — the dev server's dynamic port", () => {
    // The page is served from the dev SERVER's port (5173), not the reload port (35729),
    // so the Origin is a loopback host on a different port and must still pass.
    expect(
      isLiveReloadUpgradeAllowed({
        origin: "http://127.0.0.1:5173",
        host: `127.0.0.1:${reloadPort}`,
        port: reloadPort,
      }),
    ).toBe(true);
    expect(
      isLiveReloadUpgradeAllowed({
        origin: "http://localhost:8080",
        host: `localhost:${reloadPort}`,
        port: reloadPort,
      }),
    ).toBe(true);
  });

  it("allows a non-browser client with no Origin (no rebinding risk)", () => {
    expect(
      isLiveReloadUpgradeAllowed({
        origin: undefined,
        host: `127.0.0.1:${reloadPort}`,
        port: reloadPort,
      }),
    ).toBe(true);
  });

  it("refuses a foreign Origin even on a loopback Host (the browser-tab CSRF vector)", () => {
    expect(
      isLiveReloadUpgradeAllowed({
        origin: "https://evil.example",
        host: `127.0.0.1:${reloadPort}`,
        port: reloadPort,
      }),
    ).toBe(false);
  });

  it("refuses a malformed Origin", () => {
    expect(
      isLiveReloadUpgradeAllowed({
        origin: "not a url",
        host: `127.0.0.1:${reloadPort}`,
        port: reloadPort,
      }),
    ).toBe(false);
  });

  it("refuses a foreign or absent Host (the DNS-rebinding name, or a missing Host)", () => {
    expect(
      isLiveReloadUpgradeAllowed({
        origin: undefined,
        host: `evil.example:${reloadPort}`,
        port: reloadPort,
      }),
    ).toBe(false);
    expect(
      isLiveReloadUpgradeAllowed({ origin: undefined, host: undefined, port: reloadPort }),
    ).toBe(false);
  });
});
