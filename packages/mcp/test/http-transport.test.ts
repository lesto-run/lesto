import { describe, expect, it } from "vitest";

import { gateDevRequest, isHostAllowed, loopbackAllowlist } from "../src/http-transport";

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
    expect(gateDevRequest({ ...ok, token: "guessed" })).toMatchObject({
      reason: "a missing or wrong session token",
    });
  });
});
