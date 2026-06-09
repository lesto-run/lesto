import { describe, expect, it } from "vitest";

import { generateToken, verifyToken } from "../src/index";

const SECRET = "a-server-side-secret";

describe("generateToken / verifyToken", () => {
  it("verifies a token it just minted", () => {
    const token = generateToken(SECRET);

    expect(verifyToken(token, SECRET)).toBe(true);
  });

  it("rejects a token under the wrong secret", () => {
    const token = generateToken(SECRET);

    expect(verifyToken(token, "a-different-secret")).toBe(false);
  });

  it("rejects a malformed token with no separator", () => {
    expect(verifyToken("noseparatorhere", SECRET)).toBe(false);
  });

  it("rejects a token with too many parts", () => {
    const token = generateToken(SECRET);

    expect(verifyToken(token + ".extra", SECRET)).toBe(false);
  });

  it("rejects a token whose signature is the wrong length", () => {
    const [nonce] = generateToken(SECRET).split(".") as [string, string];

    // A signature that is too short trips the length guard before timingSafeEqual.
    expect(verifyToken(nonce + ".deadbeef", SECRET)).toBe(false);
  });

  it("mints a fresh token every call", () => {
    expect(generateToken(SECRET)).not.toBe(generateToken(SECRET));
  });
});
