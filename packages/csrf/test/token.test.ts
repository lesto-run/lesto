import { describe, expect, it } from "vitest";

import { generateToken, verifyToken } from "../src/index";

const SECRET = "a-server-side-secret";
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
});
