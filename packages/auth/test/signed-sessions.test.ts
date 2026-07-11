import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthError, SignedSessions } from "../src/index";
import type { Clock } from "../src/index";

// >= 32 bytes: a real signing secret (the weak-secret guard rejects shorter).
const SECRET = "test-signing-secret-0123456789ab";

// A clock we can stop, so every expiry path is exact.
function stoppedClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let now = start;

  return { clock: () => now, advance: (ms) => (now += ms) };
}

// Forge a token with an arbitrary claim payload, signed with `secret`. Lets a
// test produce a validly-signed token whose payload is the wrong shape — the
// one path `issue` can never emit.
function forge(claimJson: string, secret: string): string {
  const encoded = Buffer.from(claimJson).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("hex");

  return `${encoded}.${signature}`;
}

describe("SignedSessions", () => {
  it("issues a token that verifies back to its claim", () => {
    const { clock } = stoppedClock(1000);
    const sessions = new SignedSessions({ secret: SECRET, clock });

    const token = sessions.issue("user_1", 60_000);

    expect(sessions.verify(token)).toEqual({ userId: "user_1", expiresAt: 61_000 });
  });

  it("verifies with no store — a second instance with the same secret accepts it", () => {
    // The whole point of the edge: the verifier never saw the issue.
    const issuer = new SignedSessions({ secret: SECRET, clock: () => 1000 });
    const edge = new SignedSessions({ secret: SECRET, clock: () => 2000 });

    const token = issuer.issue("user_1", 60_000);

    expect(edge.verify(token)?.userId).toBe("user_1");
  });

  it("defaults to the system clock when none is injected", () => {
    const sessions = new SignedSessions({ secret: SECRET });

    // A token good for an hour verifies now; the default clock is real time.
    const token = sessions.issue("user_1", 60 * 60 * 1000);

    expect(sessions.verify(token)?.userId).toBe("user_1");
  });

  it("rejects an expired token", () => {
    const { clock, advance } = stoppedClock(1000);
    const sessions = new SignedSessions({ secret: SECRET, clock });

    const token = sessions.issue("user_1", 5_000);

    advance(5_000); // now === expiresAt; the boundary is exclusive.

    expect(sessions.verify(token)).toBeUndefined();
  });

  it("rejects a tampered claim (signature no longer matches)", () => {
    const sessions = new SignedSessions({ secret: SECRET, clock: () => 1000 });

    const signature = sessions.issue("user_1", 60_000).split(".")[1];

    // Re-point the claim at another user while keeping the original signature.
    const forgedClaim = Buffer.from(
      JSON.stringify({ userId: "admin", expiresAt: 61_000 }),
    ).toString("base64url");

    expect(sessions.verify(`${forgedClaim}.${signature ?? ""}`)).toBeUndefined();
  });

  it("rejects a token signed with a different secret", () => {
    const issuer = new SignedSessions({
      secret: "other-secret-0123456789abcdefghij",
      clock: () => 1000,
    });
    const verifier = new SignedSessions({ secret: SECRET, clock: () => 1000 });

    expect(verifier.verify(issuer.issue("user_1", 60_000))).toBeUndefined();
  });

  it("rejects a signature of the wrong length (constant-time guard)", () => {
    const sessions = new SignedSessions({ secret: SECRET, clock: () => 1000 });

    const [claim] = sessions.issue("user_1", 60_000).split(".");

    expect(sessions.verify(`${claim ?? ""}.deadbeef`)).toBeUndefined();
  });

  // `verify` is documented total — it must NEVER throw. A signature with the same
  // UTF-16 string length as the real 64-hex-char HMAC but a multi-byte char (legal
  // in a header/cookie) is 65 UTF-8 bytes; guarding on `string.length` would pass
  // it to `timingSafeEqual`, which throws RangeError on the byte-length mismatch.
  // The byte-length guard must return `undefined`, not throw.
  it("rejects a same-string-length non-ASCII signature without throwing", () => {
    const sessions = new SignedSessions({ secret: SECRET, clock: () => 1000 });

    const [claim] = sessions.issue("user_1", 60_000).split(".");
    const sig = `ÿ${"a".repeat(63)}`; // 64 UTF-16 units, 65 UTF-8 bytes

    expect(sig).toHaveLength(64);
    expect(Buffer.byteLength(sig, "utf8")).toBe(65);
    expect(() => sessions.verify(`${claim ?? ""}.${sig}`)).not.toThrow();
    expect(sessions.verify(`${claim ?? ""}.${sig}`)).toBeUndefined();
  });

  it("rejects a malformed token that is not two parts", () => {
    const sessions = new SignedSessions({ secret: SECRET, clock: () => 1000 });

    expect(sessions.verify("no-separator-here")).toBeUndefined();
    expect(sessions.verify("a.b.c")).toBeUndefined();
  });

  it("rejects a correctly-signed token whose payload is not valid JSON", () => {
    const sessions = new SignedSessions({ secret: SECRET, clock: () => 1000 });

    expect(sessions.verify(forge("{not json", SECRET))).toBeUndefined();
  });

  it("rejects a correctly-signed token whose payload is the wrong shape", () => {
    const sessions = new SignedSessions({ secret: SECRET, clock: () => 1000 });

    // Signature is valid, but the claim lacks a string userId / number expiresAt.
    expect(sessions.verify(forge(JSON.stringify({ foo: "bar" }), SECRET))).toBeUndefined();
    expect(sessions.verify(forge(JSON.stringify(["not", "an", "object"]), SECRET))).toBeUndefined();
    expect(sessions.verify(forge("null", SECRET))).toBeUndefined();
  });

  describe("weak-secret guard (batched P1)", () => {
    it("throws AUTH_WEAK_SECRET at construction for an empty secret", () => {
      let thrown: unknown;
      try {
        const sessions = new SignedSessions({ secret: "" });
        void sessions;
        expect.fail("should have thrown");
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(AuthError);
      expect((thrown as AuthError).code).toBe("AUTH_WEAK_SECRET");
      expect((thrown as AuthError).details).toMatchObject({ bytes: 0, minBytes: 32 });
    });

    it("throws AUTH_WEAK_SECRET for a 31-byte secret (just under the boundary)", () => {
      const thirtyOne = "a".repeat(31);
      expect(() => new SignedSessions({ secret: thirtyOne })).toThrowError(AuthError);
    });

    it("accepts an exactly-32-byte secret (the boundary is inclusive)", () => {
      const thirtyTwo = "a".repeat(32);
      expect(() => new SignedSessions({ secret: thirtyTwo })).not.toThrow();
    });
  });
});
