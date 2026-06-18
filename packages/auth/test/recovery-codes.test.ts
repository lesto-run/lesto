import { describe, expect, it } from "vitest";

import {
  generateRecoveryCodes,
  hashRecoveryCodes,
  verifyPassword,
  verifyRecoveryCode,
} from "../src/index";

describe("generateRecoveryCodes", () => {
  it("produces ten grouped, lowercase codes by default", () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(10);

    for (const code of codes) {
      // Ten legible symbols grouped 4-4-2 with hyphens, e.g. `a1b2-c3d4-e5`.
      expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{2}$/);
    }
  });

  it("honors a custom count", () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });

  it("produces distinct codes within a batch", () => {
    const codes = generateRecoveryCodes(10);

    expect(new Set(codes).size).toBe(10);
  });
});

describe("hashRecoveryCodes / verifyRecoveryCode", () => {
  it("hashes each code with the scrypt password format (no second hasher)", async () => {
    const [code] = generateRecoveryCodes(1) as [string];

    const [hash] = await hashRecoveryCodes([code]);

    // Reuses hashPassword verbatim: the digest is the self-describing scrypt form.
    expect(hash!.startsWith(`scrypt$${2 ** 17}$8$1$`)).toBe(true);
    // And it verifies through the password primitive too — one implementation.
    expect(await verifyPassword(code, hash!)).toBe(true);
  });

  it("verifies a code against its own hash", async () => {
    const codes = generateRecoveryCodes(2);
    const hashes = await hashRecoveryCodes(codes);

    expect(await verifyRecoveryCode(codes[0]!, hashes[0]!)).toBe(true);
    expect(await verifyRecoveryCode(codes[1]!, hashes[1]!)).toBe(true);
  });

  it("rejects a code against a different code's hash", async () => {
    const codes = generateRecoveryCodes(2);
    const hashes = await hashRecoveryCodes(codes);

    expect(await verifyRecoveryCode(codes[0]!, hashes[1]!)).toBe(false);
  });

  it("fails closed on a malformed stored hash (never throws)", async () => {
    expect(await verifyRecoveryCode("anything", "not-a-hash")).toBe(false);
  });
});
