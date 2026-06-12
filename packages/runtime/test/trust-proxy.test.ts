import { describe, expect, it } from "vitest";

import { resolveClient } from "../src/index";

import type { TrustProxy } from "../src/index";

// Hoisted: a predicate captures nothing, so it lives once at module scope.
const trustLan: TrustProxy = (peer) => peer.startsWith("10.");

const alwaysTrust: TrustProxy = () => true;

describe("resolveClient — default (trust nothing)", () => {
  it("uses the socket peer and http when trustProxy is false", () => {
    const client = resolveClient(false, "203.0.113.5", {
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
    });

    // The forwarding headers are ignored — they are trivially forged.
    expect(client.ip).toBe("203.0.113.5");
    expect(client.protocol).toBe("http");
  });

  it("reports an undefined ip when the socket peer is unknown", () => {
    const client = resolveClient(false, undefined, {});

    expect(client.ip).toBeUndefined();
    expect(client.protocol).toBe("http");
  });
});

describe("resolveClient — true (one trusted hop, right-most)", () => {
  it("believes the RIGHT-most X-Forwarded-For entry and the proto", () => {
    // One proxy in front appended the address it observed; that is the right-most
    // entry, the only slot no upstream client can position.
    const client = resolveClient(true, "10.0.0.1", {
      "x-forwarded-for": "1.2.3.4, 10.0.0.9",
      "x-forwarded-proto": "https",
    });

    expect(client.ip).toBe("10.0.0.9");
    expect(client.protocol).toBe("https");
  });

  it("ignores a prepended XFF spoof: the LB-appended real IP wins (blocker #4)", () => {
    // The attacker sets `X-Forwarded-For: 1.2.3.4`; our single load balancer
    // appends the address it actually accepted the connection from. With `true` =
    // one trusted hop, the resolved client is the right-most entry, so the forged
    // left-most prefix cannot move the rate-limit/audit key.
    const client = resolveClient(true, "10.0.0.1", {
      "x-forwarded-for": "1.2.3.4, 203.0.113.7",
    });

    expect(client.ip).toBe("203.0.113.7");
  });

  it("falls back to the socket peer when a trusted peer sent no XFF", () => {
    const client = resolveClient(true, "10.0.0.1", {});

    expect(client.ip).toBe("10.0.0.1");
    // No XFP either: default to http.
    expect(client.protocol).toBe("http");
  });

  it("uses the first X-Forwarded-Proto value when several are present", () => {
    const client = resolveClient(true, "10.0.0.1", {
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https, http",
    });

    expect(client.protocol).toBe("https");
  });
});

describe('resolveClient — "all" escape hatch (left-most, legacy)', () => {
  it("trusts the whole chain and takes the LEFT-most (forgeable) entry", () => {
    const client = resolveClient("all", "10.0.0.1", {
      "x-forwarded-for": "1.2.3.4, 10.0.0.9",
      "x-forwarded-proto": "https",
    });

    expect(client.ip).toBe("1.2.3.4");
    expect(client.protocol).toBe("https");
  });

  it("falls back to the socket peer when an all-trusted peer sent no XFF", () => {
    const client = resolveClient("all", "10.0.0.1", {});

    expect(client.ip).toBe("10.0.0.1");
  });
});

describe("resolveClient — hop count", () => {
  it("peels n trusted hops from the right of the chain", () => {
    // client -> proxyA -> proxyB(ours); with 1 trusted hop, the client we
    // believe is the entry just before our single appended hop.
    const client = resolveClient(1, "10.0.0.9", {
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    });

    expect(client.ip).toBe("1.2.3.4");
  });

  it("clamps to the left-most entry when the chain is shorter than the hop count", () => {
    const client = resolveClient(3, "10.0.0.9", {
      "x-forwarded-for": "1.2.3.4",
    });

    expect(client.ip).toBe("1.2.3.4");
  });

  it("does not trust the peer when the hop count is zero", () => {
    const client = resolveClient(0, "10.0.0.9", {
      "x-forwarded-for": "1.2.3.4",
    });

    // Zero hops trusts no forwarding: the socket peer stands.
    expect(client.ip).toBe("10.0.0.9");
    expect(client.protocol).toBe("http");
  });

  it("falls back to the socket peer when a trusted hop policy sees an empty chain", () => {
    const client = resolveClient(2, "10.0.0.9", {});

    expect(client.ip).toBe("10.0.0.9");
  });
});

describe("resolveClient — predicate (peels trusted hops right-to-left)", () => {
  it("peels every entry the predicate accepts, leaving the left-most client", () => {
    // trustLan accepts the trailing 10.x hop, then index reaches 0 (the loop
    // stops), so the left-most originating client stands.
    const client = resolveClient(trustLan, "10.0.0.5", {
      "x-forwarded-for": "1.2.3.4, 10.0.0.9",
      "x-forwarded-proto": "https",
    });

    expect(client.ip).toBe("1.2.3.4");
    expect(client.protocol).toBe("https");
  });

  it("stops peeling at the first entry the predicate rejects (the perimeter ingress)", () => {
    // Two of our own 10.x hops appended on the right; the entry that entered the
    // perimeter (8.8.8.8, public) is rejected by trustLan and becomes the client —
    // NOT the left-most forgeable 1.2.3.4 a client could prepend.
    const client = resolveClient(trustLan, "10.0.0.5", {
      "x-forwarded-for": "1.2.3.4, 8.8.8.8, 10.0.0.9, 10.0.0.10",
    });

    expect(client.ip).toBe("8.8.8.8");
  });

  it("does not trust forwarding when the predicate rejects the peer", () => {
    const client = resolveClient(trustLan, "203.0.113.5", {
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
    });

    expect(client.ip).toBe("203.0.113.5");
    expect(client.protocol).toBe("http");
  });

  it("never trusts a predicate policy when the peer address is unknown", () => {
    const client = resolveClient(alwaysTrust, undefined, { "x-forwarded-for": "1.2.3.4" });

    // No peer to vouch for -> no trust -> undefined socket ip.
    expect(client.ip).toBeUndefined();
  });

  it("ignores empty/whitespace entries in the forwarding chain", () => {
    const client = resolveClient(true, "10.0.0.1", {
      "x-forwarded-for": " , 1.2.3.4 , ",
    });

    expect(client.ip).toBe("1.2.3.4");
  });
});
