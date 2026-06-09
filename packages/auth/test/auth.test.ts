import { describe, expect, it } from "vitest";

import {
  AuthError,
  generateToken,
  hashPassword,
  KeelError,
  MemorySessionStore,
  Sessions,
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

describe("hashPassword / verifyPassword", () => {
  it("round-trips: a hashed password verifies against itself", () => {
    const stored = hashPassword("correct horse battery staple");

    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const stored = hashPassword("correct horse battery staple");

    expect(verifyPassword("Tr0ub4dour&3", stored)).toBe(false);
  });

  it("returns false for a stored string with too few $-parts", () => {
    expect(verifyPassword("anything", "scrypt$onlytwoparts")).toBe(false);
  });

  it("returns false for a stored string with too many $-parts", () => {
    expect(verifyPassword("anything", "scrypt$aa$bb$cc")).toBe(false);
  });

  it("returns false for a stored string with the wrong algorithm prefix", () => {
    expect(verifyPassword("anything", "bcrypt$abcd$ef01")).toBe(false);
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

describe("Sessions", () => {
  it("create returns a token bound to the user with the expected expiry", () => {
    const { clock } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    const session = sessions.create("user_1", 60_000);

    expect(session.userId).toBe("user_1");
    expect(session.token).toHaveLength(64);
    expect(session.expiresAt).toBe(61_000);
  });

  it("verify returns a live session", () => {
    const { clock, advance } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    const session = sessions.create("user_1", 60_000);

    advance(30_000);

    expect(sessions.verify(session.token)).toEqual(session);
  });

  it("verify returns undefined for an expired session and deletes it", () => {
    const { clock, advance } = stoppedClock(1_000);
    const store = new MemorySessionStore();
    const sessions = new Sessions({ store, clock });

    const session = sessions.create("user_1", 60_000);

    advance(60_000);

    expect(sessions.verify(session.token)).toBeUndefined();
    expect(store.find(session.token)).toBeUndefined();
  });

  it("verify returns undefined for an unknown token", () => {
    const { clock } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    expect(sessions.verify("nope")).toBeUndefined();
  });

  it("revoke invalidates a live session", () => {
    const { clock } = stoppedClock(1_000);
    const sessions = new Sessions({ store: new MemorySessionStore(), clock });

    const session = sessions.create("user_1", 60_000);

    sessions.revoke(session.token);

    expect(sessions.verify(session.token)).toBeUndefined();
  });

  it("defaults to the system clock when none is injected", () => {
    const sessions = new Sessions({ store: new MemorySessionStore() });

    const before = systemClock();
    const session = sessions.create("user_1", 60_000);

    // The default clock is the real wall clock: expiry sits ~ttl in the future.
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(sessions.verify(session.token)).toEqual(session);
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
