import { describe, expect, it } from "vitest";

import { CsrfError, generateToken, verifyToken } from "../src/index";

// >= 32 bytes: a real CSRF secret (the weak-secret guard rejects shorter).
const SECRET = "a-server-side-secret-0123456789ab";
const SESSION = "session_a";

describe("generateToken / verifyToken", () => {
  it("verifies a token it just minted for the same session", () => {
    const token = generateToken(SESSION, SECRET);

    expect(verifyToken(token, SESSION, SECRET)).toBe(true);
  });

  it("rejects a token under the wrong secret", () => {
    const token = generateToken(SESSION, SECRET);

    expect(verifyToken(token, SESSION, "a-different-secret")).toBe(false);
  });

  it("rejects a malformed token with no separator", () => {
    expect(verifyToken("noseparatorhere", SESSION, SECRET)).toBe(false);
  });

  it("rejects a token with too many parts", () => {
    const token = generateToken(SESSION, SECRET);

    expect(verifyToken(token + ".extra", SESSION, SECRET)).toBe(false);
  });

  it("rejects a token whose signature is the wrong length", () => {
    const [nonce] = generateToken(SESSION, SECRET).split(".") as [string, string];

    // A signature that is too short trips the length guard before timingSafeEqual.
    expect(verifyToken(nonce + ".deadbeef", SESSION, SECRET)).toBe(false);
  });

  // F6: a real hex signature is 64 ASCII chars (64 bytes). A forgery of the same
  // *string* length but carrying a non-ASCII char — legal latin-1 in an HTTP
  // header — has a greater *byte* length once UTF-8-encoded. A string-length
  // guard lets it through to timingSafeEqual, which throws RangeError on a
  // byte-size mismatch — escaping the total contract and turning a 403 into a
  // 500 an attacker can trigger at will. verify must stay total: `false`.
  it("stays total for a same-string-length signature with non-ASCII bytes", () => {
    const [nonce] = generateToken(SESSION, SECRET).split(".") as [string, string];

    // 64 UTF-16 code units (matches a hex signature's string length) …
    const nonAsciiSig = "ÿ" + "a".repeat(63);
    expect(nonAsciiSig).toHaveLength(64);
    // … but 65 bytes in UTF-8 — the byte-length mismatch that trips the throw.
    expect(Buffer.byteLength(nonAsciiSig, "utf8")).toBe(65);

    expect(verifyToken(nonce + "." + nonAsciiSig, SESSION, SECRET)).toBe(false);
  });

  it("mints a fresh token every call", () => {
    expect(generateToken(SESSION, SECRET)).not.toBe(generateToken(SESSION, SECRET));
  });

  // Session binding: the signed payload folds in the session id, so a token
  // valid for one session must not verify under another.
  it("rejects a token minted for session A when presented under session B", () => {
    const token = generateToken("session_a", SECRET);

    expect(verifyToken(token, "session_b", SECRET)).toBe(false);
  });

  it("accepts a token only under the matching session", () => {
    const token = generateToken("session_a", SECRET);

    expect(verifyToken(token, "session_a", SECRET)).toBe(true);
    expect(verifyToken(token, "session_b", SECRET)).toBe(false);
  });

  it("binds distinctly so no delimiter-splicing collision occurs", () => {
    // (nonce + "x", "y") and (nonce, "xy") must not produce the same payload.
    // The NUL delimiter — impossible in a hex nonce — guarantees this.
    const tokenForXY = generateToken("xy", SECRET);

    expect(verifyToken(tokenForXY, "xy", SECRET)).toBe(true);
    expect(verifyToken(tokenForXY, "x", SECRET)).toBe(false);
  });

  describe("weak-secret guard (batched P1)", () => {
    it("throws CSRF_WEAK_SECRET when minting under an empty secret", () => {
      try {
        generateToken(SESSION, "");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(CsrfError);
        expect((e as CsrfError).code).toBe("CSRF_WEAK_SECRET");
        expect((e as CsrfError).details).toMatchObject({ bytes: 0, minBytes: 32 });
      }
    });

    it("throws for a 31-byte secret (just under the boundary)", () => {
      expect(() => generateToken(SESSION, "a".repeat(31))).toThrowError(CsrfError);
    });

    it("mints under an exactly-32-byte secret (the boundary is inclusive)", () => {
      expect(() => generateToken(SESSION, "a".repeat(32))).not.toThrow();
    });

    it("verifyToken stays total — never throws, even under a weak secret", () => {
      // verify is a total predicate by contract: a weak secret is a false, not a throw.
      expect(verifyToken("anything.deadbeef", SESSION, "")).toBe(false);
    });
  });
});
