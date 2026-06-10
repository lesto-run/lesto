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

describe("resolveClient — trust all (true)", () => {
  it("believes the left-most X-Forwarded-For entry and the proto", () => {
    const client = resolveClient(true, "10.0.0.1", {
      "x-forwarded-for": "1.2.3.4, 10.0.0.9",
      "x-forwarded-proto": "https",
    });

    expect(client.ip).toBe("1.2.3.4");
    expect(client.protocol).toBe("https");
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

describe("resolveClient — predicate", () => {
  it("trusts forwarding when the predicate accepts the peer (left-most client)", () => {
    const client = resolveClient(trustLan, "10.0.0.5", {
      "x-forwarded-for": "1.2.3.4, 10.0.0.9",
      "x-forwarded-proto": "https",
    });

    expect(client.ip).toBe("1.2.3.4");
    expect(client.protocol).toBe("https");
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
