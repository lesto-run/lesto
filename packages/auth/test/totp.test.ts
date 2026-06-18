import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { generateTotpSecret, totpCode, totpKeyUri, verifyTotp } from "../src/index";

import type { Clock } from "../src/index";

// A fixed clock so every code/verification is deterministic.
const fixedClock =
  (epochMs: number): Clock =>
  () =>
    epochMs;

// RFC 6238 Appendix B test vector (SHA1): the ASCII secret "12345678901234567890",
// base32-encoded, must yield the published code at the given Unix time.
// base32("12345678901234567890") = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("generateTotpSecret", () => {
  it("produces a valid base32 string of stable width", () => {
    const secret = generateTotpSecret();

    // 20 bytes → ceil(160/5) = 32 base32 symbols, all in-alphabet.
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("is random — two secrets differ", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe("totpCode", () => {
  it("matches the RFC 6238 Appendix B SHA1 vector at T=59s", () => {
    // At Unix time 59s the published 8-digit code is 94287082; the low 6 are 287082.
    const code = totpCode(RFC_SECRET, { clock: fixedClock(59_000), digits: 8 });

    expect(code).toBe("94287082");
  });

  it("matches a second RFC vector at T=1111111109s", () => {
    const code = totpCode(RFC_SECRET, { clock: fixedClock(1_111_111_109_000), digits: 8 });

    expect(code).toBe("07081804");
  });

  it("defaults to six digits", () => {
    const code = totpCode(RFC_SECRET, { clock: fixedClock(59_000) });

    expect(code).toBe("287082");
  });

  it("returns undefined for a non-base32 secret (fail closed)", () => {
    expect(totpCode("not!base32", { clock: fixedClock(0) })).toBeUndefined();
  });

  it("uses the system clock when none is injected", () => {
    // No clock → real time; we only assert the shape (deterministic value would
    // require freezing the wall clock).
    expect(totpCode(RFC_SECRET)).toMatch(/^[0-9]{6}$/);
  });

  it("honors a custom time step", () => {
    // With a 60s step the counter halves vs. the 30s default at the same instant.
    const expected = (() => {
      const counter = Math.floor(59 / 60); // = 0
      const key = Buffer.from("12345678901234567890");
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64BE(BigInt(counter));
      const hmac = createHmac("sha1", key).update(buf).digest();
      const offset = hmac[hmac.length - 1]! & 0x0f;
      const binary =
        ((hmac[offset]! & 0x7f) << 24) |
        ((hmac[offset + 1]! & 0xff) << 16) |
        ((hmac[offset + 2]! & 0xff) << 8) |
        (hmac[offset + 3]! & 0xff);
      return String(binary % 1_000_000).padStart(6, "0");
    })();

    expect(totpCode(RFC_SECRET, { clock: fixedClock(59_000), timeStep: 60 })).toBe(expected);
  });
});

describe("verifyTotp", () => {
  const secret = generateTotpSecret();

  it("verifies the code computed for the same instant", () => {
    const clock = fixedClock(1_700_000_000_000);
    const code = totpCode(secret, { clock })!;

    expect(verifyTotp(secret, code, { clock })).toBe(true);
  });

  it("accepts a code from the previous step (drift, default ±1)", () => {
    // Code minted one step (30s) earlier still verifies at the later instant.
    const codeEarlier = totpCode(secret, { clock: fixedClock(1_700_000_000_000) })!;

    expect(verifyTotp(secret, codeEarlier, { clock: fixedClock(1_700_000_030_000) })).toBe(true);
  });

  it("accepts a code from the next step (drift, default ±1)", () => {
    const codeLater = totpCode(secret, { clock: fixedClock(1_700_000_030_000) })!;

    expect(verifyTotp(secret, codeLater, { clock: fixedClock(1_700_000_000_000) })).toBe(true);
  });

  it("rejects a code two steps away (outside the ±1 window)", () => {
    const codeFar = totpCode(secret, { clock: fixedClock(1_700_000_000_000) })!;

    expect(verifyTotp(secret, codeFar, { clock: fixedClock(1_700_000_090_000) })).toBe(false);
  });

  it("accepts a two-step drift when the window is widened to 2", () => {
    // Minted at step T0, checked 60s (2 steps) later — outside ±1, inside ±2.
    const codeFar = totpCode(secret, { clock: fixedClock(1_700_000_000_000) })!;

    expect(verifyTotp(secret, codeFar, { clock: fixedClock(1_700_000_000_000), window: 2 })).toBe(
      true,
    );
    expect(verifyTotp(secret, codeFar, { clock: fixedClock(1_700_000_060_000), window: 2 })).toBe(
      true,
    );
    // And one step beyond the widened window is still rejected.
    expect(verifyTotp(secret, codeFar, { clock: fixedClock(1_700_000_090_000), window: 2 })).toBe(
      false,
    );
  });

  it("rejects a wrong-length code (fail closed, no compare)", () => {
    expect(verifyTotp(secret, "123", { clock: fixedClock(0) })).toBe(false);
  });

  it("rejects a non-digit code", () => {
    expect(verifyTotp(secret, "abcdef", { clock: fixedClock(0) })).toBe(false);
  });

  it("rejects against a malformed secret (fail closed)", () => {
    // The candidate has the right shape, but the secret is not base32 → undefined
    // expected for every offset → false.
    expect(verifyTotp("not!base32", "000000", { clock: fixedClock(0) })).toBe(false);
  });

  it("rejects against an empty / all-padding secret (decodes to nothing)", () => {
    // After stripping whitespace and `=` padding the secret is empty → undefined
    // expected → false, never a throw.
    expect(verifyTotp("   == ", "000000", { clock: fixedClock(0) })).toBe(false);
  });

  it("uses the system clock when none is injected", () => {
    const code = totpCode(secret)!;

    expect(verifyTotp(secret, code)).toBe(true);
  });

  it("decodes a lowercase, space-grouped secret (authenticator display form)", () => {
    const clock = fixedClock(1_700_000_000_000);
    const code = totpCode(secret, { clock })!;

    // Same secret displayed the way an app shows it: lowercased and spaced.
    const display = secret
      .toLowerCase()
      .replace(/(.{4})/g, "$1 ")
      .trim();

    expect(verifyTotp(display, code, { clock })).toBe(true);
  });
});

describe("totpKeyUri", () => {
  it("builds an otpauth URI with percent-encoded label and params", () => {
    const uri = totpKeyUri({
      secret: "ABC234",
      issuer: "Lesto Demo",
      account: "ada@example.com",
    });

    expect(uri.startsWith("otpauth://totp/Lesto%20Demo:ada%40example.com?")).toBe(true);
    expect(uri).toContain("secret=ABC234");
    expect(uri).toContain("issuer=Lesto+Demo");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("embeds custom digits and time step when provided", () => {
    const uri = totpKeyUri({
      secret: "ABC234",
      issuer: "Lesto",
      account: "ada@example.com",
      digits: 8,
      timeStep: 60,
    });

    expect(uri).toContain("digits=8");
    expect(uri).toContain("period=60");
  });
});
