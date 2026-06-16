import { describe, expect, it } from "vitest";

import {
  AuthError,
  generateToken,
  hashPassword,
  KeelError,
  MemorySessionStore,
  needsRehash,
  Sessions,
  sha256,
  systemClock,
  verifyPassword,
} from "../src/index";

import type { Clock } from "../src/index";

// A clock we can stop, so every expiry path is deterministic.
const stoppedClock = (start: number): { clock: Clock; advance: (ms: number) => void } => {
  let now = start;

  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

// The current-format param prefix `scrypt$N$r$p` (defaults match the live cost).
const params = (n = 2 ** 17, r = 8, p = 1): string => `scrypt$${n}$${r}$${p}`;

describe("hashPassword / verifyPassword", () => {
  it("round-trips: a hashed password verifies against itself", async () => {
    const stored = await hashPassword("correct horse battery staple");

    // The current format is self-describing: scrypt$N$r$p$salt$hash.
    expect(stored.startsWith(`scrypt$${2 ** 17}$8$1$`)).toBe(true);
    expect(stored.split("$")).toHaveLength(6);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("Tr0ub4dour&3", stored)).toBe(false);
  });

  it("uses a fresh salt per call (two hashes of the same password differ)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");

    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("returns false for a stored string with too few $-parts", async () => {
    expect(await verifyPassword("anything", "scrypt$onlytwoparts")).toBe(false);
  });

  it("returns false for a stored string with the wrong segment count (4 or 5)", async () => {
    expect(await verifyPassword("anything", "scrypt$aa$bb$cc")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$131072$8$1$aa")).toBe(false);
  });

  it("returns false for a stored string with the wrong algorithm prefix", async () => {
    expect(await verifyPassword("anything", "bcrypt$abcd$ef01")).toBe(false);
  });

  // The salt is fixed at 16 bytes and the scrypt key at 64 bytes, so a
  // well-formed stored string carries 32 + 128 hex chars respectively.
  const SALT_HEX = "a".repeat(16 * 2);
  const KEY_HEX = "b".repeat(64 * 2);

  it("rejects a current-format hash with non-numeric params", async () => {
    expect(await verifyPassword("x", `scrypt$notanumber$8$1$${SALT_HEX}$${KEY_HEX}`)).toBe(false);
    expect(await verifyPassword("x", `scrypt$131072$r$1$${SALT_HEX}$${KEY_HEX}`)).toBe(false);
    expect(await verifyPassword("x", `scrypt$131072$8$p$${SALT_HEX}$${KEY_HEX}`)).toBe(false);
  });

  it("rejects a current-format hash with non-positive or non-integer params", async () => {
    expect(await verifyPassword("x", `scrypt$0$8$1$${SALT_HEX}$${KEY_HEX}`)).toBe(false);
    expect(await verifyPassword("x", `scrypt$131072$8$1.5$${SALT_HEX}$${KEY_HEX}`)).toBe(false);
  });

  it("rejects a current-format hash whose N is not a power of two", async () => {
    expect(await verifyPassword("x", `scrypt$100000$8$1$${SALT_HEX}$${KEY_HEX}`)).toBe(false);
  });

  it("rejects every password when the stored hash is empty (auth fails closed)", async () => {
    const empty = `${params()}$${SALT_HEX}$`;

    expect(await verifyPassword("", empty)).toBe(false);
    expect(await verifyPassword("any password at all", empty)).toBe(false);
    expect(await verifyPassword(" ", empty)).toBe(false);
  });

  it("rejects every password when the stored hash is truncated", async () => {
    // One byte short of the 64-byte key.
    const truncated = `${params()}$${SALT_HEX}$${"b".repeat((64 - 1) * 2)}`;

    expect(await verifyPassword("any password at all", truncated)).toBe(false);
  });

  it("rejects every password when the stored hash is oversized", async () => {
    // One byte longer than the 64-byte key.
    const oversized = `${params()}$${SALT_HEX}$${"b".repeat((64 + 1) * 2)}`;

    expect(await verifyPassword("any password at all", oversized)).toBe(false);
  });

  it("rejects when the salt is the wrong length", async () => {
    const shortSalt = "ab"; // 1 byte, not the expected 16
    const badSalt = `${params()}$${shortSalt}$${KEY_HEX}`;

    expect(await verifyPassword("any password at all", badSalt)).toBe(false);
  });

  it("still verifies a correctly-shaped, correct password", async () => {
    const stored = await hashPassword("the right password");

    expect(await verifyPassword("the right password", stored)).toBe(true);
    expect(await verifyPassword("the wrong password", stored)).toBe(false);
  });

  // --- Backward-compatibility: legacy parameterless format -----------------
  // Old rows are `scrypt$salt$hash`, minted under N=2^14. They must still
  // verify so existing users are not locked out, and be flagged for rehash.
  it("verifies a legacy parameterless hash (scrypt$salt$hash, N=2^14)", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("legacy password", salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const legacy = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;

    expect(legacy.split("$")).toHaveLength(3);
    expect(await verifyPassword("legacy password", legacy)).toBe(true);
    expect(await verifyPassword("wrong", legacy)).toBe(false);
  });

  it("verifies a hash minted under non-default (older, smaller-N) params", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("aged password", salt, 64, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    const aged = `scrypt$${2 ** 15}$8$1$${salt.toString("hex")}$${key.toString("hex")}`;

    expect(await verifyPassword("aged password", aged)).toBe(true);
  });
});

describe("needsRehash", () => {
  it("returns false for a hash minted at the current cost", async () => {
    const stored = await hashPassword("current");

    expect(needsRehash(stored)).toBe(false);
  });

  it("returns true for a legacy parameterless hash", () => {
    const SALT_HEX = "a".repeat(32);
    const KEY_HEX = "b".repeat(128);

    expect(needsRehash(`scrypt$${SALT_HEX}$${KEY_HEX}`)).toBe(true);
  });

  it("returns true when N is below the current default", () => {
    const SALT_HEX = "a".repeat(32);
    const KEY_HEX = "b".repeat(128);

    expect(needsRehash(`scrypt$${2 ** 15}$8$1$${SALT_HEX}$${KEY_HEX}`)).toBe(true);
  });

  it("returns true when r or p is below the current default", () => {
    const SALT_HEX = "a".repeat(32);
    const KEY_HEX = "b".repeat(128);

    // r below default (the parse still requires a power-of-two N).
    expect(needsRehash(`scrypt$${2 ** 17}$4$1$${SALT_HEX}$${KEY_HEX}`)).toBe(true);
    // p below default is impossible above zero (default p=1), but a hash with a
    // higher N/r and matching p stays stable — exercised by the false case.
  });

  it("returns false for a malformed string (nothing to rehash from)", () => {
    expect(needsRehash("not a hash")).toBe(false);
    expect(needsRehash("scrypt$bad$8$1$aa$bb")).toBe(false);
  });
});

describe("generateToken", () => {
  it("defaults to 32 bytes (64 hex chars)", () => {
    expect(generateToken()).toHaveLength(64);
  });

  it("honours a custom byte length", () => {
    expect(generateToken(8)).toHaveLength(16);
  });

  it("produces distinct tokens", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("sha256", () => {
  it("matches the known SHA-256 digest of a string (lowercase hex)", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic — the same input always yields the same digest", () => {
    expect(sha256("keel")).toBe(sha256("keel"));
  });

  it("distinguishes different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("Sessions", () => {
  it("create returns a token bound to the user with the expected expiry", async () => {
    const { clock } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    const session = await sessions.create("user_1", 60_000);

    expect(session.userId).toBe("user_1");
    expect(session.token).toHaveLength(64);
    expect(session.expiresAt).toBe(61_000);
  });

  it("verify returns a live session", async () => {
    const { clock, advance } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    const session = await sessions.create("user_1", 60_000);

    advance(30_000);

    expect(await sessions.verify(session.token)).toEqual(session);
  });

  it("verify returns undefined for an expired session and deletes it", async () => {
    const { clock, advance } = stoppedClock(1_000);
    const store = new MemorySessionStore();
    const sessions = new Sessions({ store, clock });

    const session = await sessions.create("user_1", 60_000);

    advance(60_000);

    expect(await sessions.verify(session.token)).toBeUndefined();
    expect(await store.find(session.token)).toBeUndefined();
  });

  it("verify returns undefined for an unknown token", async () => {
    const { clock } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    expect(await sessions.verify("nope")).toBeUndefined();
  });

  it("revoke invalidates a live session", async () => {
    const { clock } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    const session = await sessions.create("user_1", 60_000);

    await sessions.revoke(session.token);

    expect(await sessions.verify(session.token)).toBeUndefined();
  });

  it("defaults to the system clock when none is injected", async () => {
    const sessions = new Sessions({ store: new MemorySessionStore() });

    const before = systemClock();
    const session = await sessions.create("user_1", 60_000);

    // The default clock is the real wall clock: expiry sits ~ttl in the future.
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(await sessions.verify(session.token)).toEqual(session);
  });
});

describe("AuthError", () => {
  it("carries a stable code and frozen details", () => {
    const error = new AuthError("AUTH_INVALID_HASH", "bad hash", { stored: "x" });

    expect(error).toBeInstanceOf(KeelError);
    expect(error.code).toBe("AUTH_INVALID_HASH");
    expect(error.name).toBe("AuthError");
    expect(error.details).toEqual({ stored: "x" });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("defaults details to an empty frozen object", () => {
    const error = new AuthError("AUTH_INVALID_HASH", "bad hash");

    expect(error.details).toEqual({});
  });
});
