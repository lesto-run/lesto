import { randomBytes, scryptSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthError,
  hashPassword,
  hashPasswordScrypt,
  hashPasswordWeb,
  needsRehash,
  needsRehashWeb,
  selectPasswordAlgorithm,
  verifyPassword,
  verifyPasswordWeb,
} from "../src/index";

// A valid hex string for `bytes` bytes (all zero) — parseable salt/key material we
// can then perturb (wrong length, wrong chars) to drive the fail-closed branches.
const hexOf = (bytes: number): string => "0".repeat(bytes * 2);
const VALID_SALT = hexOf(16);
const VALID_KEY = hexOf(32);

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Mint a PBKDF2 hash directly with an arbitrary iteration count, mirroring the
// module's own format — so we can exercise "verifies a hash minted under a lower
// cost" and the rehash seam without waiting on the 600k-iteration production cost.
async function pbkdf2Hash(password: string, iterations: number): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password) as Uint8Array<ArrayBuffer>,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    keyMaterial,
    32 * 8,
  );

  return `pbkdf2$sha256$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

describe("hashPasswordWeb / verifyPasswordWeb", () => {
  it("mints a self-describing pbkdf2 hash that round-trips", async () => {
    const stored = await hashPasswordWeb("correct horse battery staple");

    // pbkdf2$<digest>$<iterations>$<salt>$<key> — OWASP's 600k SHA-256 floor.
    expect(stored.startsWith("pbkdf2$sha256$600000$")).toBe(true);
    expect(stored.split("$")).toHaveLength(5);

    expect(await verifyPasswordWeb("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPasswordWeb("correct horse battery staple");

    expect(await verifyPasswordWeb("Tr0ub4dour&3", stored)).toBe(false);
  });

  it("uses a fresh salt each time, so the same password hashes differently", async () => {
    const a = await hashPasswordWeb("same password");
    const b = await hashPasswordWeb("same password");

    expect(a).not.toBe(b);
    expect(await verifyPasswordWeb("same password", a)).toBe(true);
    expect(await verifyPasswordWeb("same password", b)).toBe(true);
  });

  it("verifies a hash minted under a lower (older) iteration count", async () => {
    const aged = await pbkdf2Hash("aged password", 1000);

    expect(await verifyPasswordWeb("aged password", aged)).toBe(true);
    expect(await verifyPasswordWeb("wrong", aged)).toBe(false);
  });

  // Every malformed shape must verify to `false` — never throw, never fail open.
  it("fails closed on every malformed stored string", async () => {
    const malformed = [
      "", // one segment
      `pbkdf2$sha256$600000$${VALID_SALT}`, // too few segments
      `pbkdf2$sha256$600000$${VALID_SALT}$${VALID_KEY}$extra`, // too many
      `bcrypt$sha256$600000$${VALID_SALT}$${VALID_KEY}`, // wrong prefix
      `pbkdf2$sha512$600000$${VALID_SALT}$${VALID_KEY}`, // unknown digest tag
      `pbkdf2$toString$600000$${VALID_SALT}$${VALID_KEY}`, // inherited-proto digest tag — must NOT throw
      `pbkdf2$constructor$600000$${VALID_SALT}$${VALID_KEY}`, // ditto
      `pbkdf2$sha256$notanumber$${VALID_SALT}$${VALID_KEY}`, // non-numeric iterations
      `pbkdf2$sha256$0$${VALID_SALT}$${VALID_KEY}`, // zero iterations
      `pbkdf2$sha256$-5$${VALID_SALT}$${VALID_KEY}`, // negative iterations
      `pbkdf2$sha256$1.5$${VALID_SALT}$${VALID_KEY}`, // non-integer iterations
      `pbkdf2$sha256$600000$abc$${VALID_KEY}`, // odd-length salt hex
      `pbkdf2$sha256$600000$${"z".repeat(32)}$${VALID_KEY}`, // non-hex salt
      `pbkdf2$sha256$600000$${VALID_SALT}$abc`, // odd-length key hex
      `pbkdf2$sha256$600000$${VALID_SALT}$${"z".repeat(64)}`, // non-hex key
      `pbkdf2$sha256$600000$${hexOf(15)}$${VALID_KEY}`, // salt is the wrong width
      `pbkdf2$sha256$600000$${VALID_SALT}$${hexOf(31)}`, // key is the wrong width
      `pbkdf2$sha256$600000$$${VALID_KEY}`, // empty salt segment
    ];

    for (const stored of malformed) {
      expect(await verifyPasswordWeb("any password at all", stored)).toBe(false);
    }
  });
});

describe("needsRehashWeb", () => {
  it("is false for a freshly minted hash (at the current cost)", async () => {
    expect(needsRehashWeb(await hashPasswordWeb("current"))).toBe(false);
  });

  it("is true for a hash minted below the current iteration count", async () => {
    expect(needsRehashWeb(await pbkdf2Hash("aged", 1000))).toBe(true);
  });

  it("is false for a malformed string (nothing to re-derive)", () => {
    expect(needsRehashWeb("not a hash")).toBe(false);
    expect(needsRehashWeb(`pbkdf2$sha256$0$${VALID_SALT}$${VALID_KEY}`)).toBe(false);
  });
});

describe("selectPasswordAlgorithm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("picks pbkdf2 on workerd (navigator.userAgent = Cloudflare-Workers)", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

    expect(selectPasswordAlgorithm()).toBe("pbkdf2");
  });

  it("picks pbkdf2 on workerd via WebSocketPair even with no navigator flag", () => {
    // An older-compat-date Worker has no `navigator`, but always has `WebSocketPair`.
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("WebSocketPair", {});

    expect(selectPasswordAlgorithm()).toBe("pbkdf2");
  });

  it("picks scrypt on a Node-like host with no navigator", () => {
    vi.stubGlobal("navigator", undefined);

    // The test process exposes `process.versions.node`, so this is the Node path.
    expect(selectPasswordAlgorithm()).toBe("scrypt");
  });

  it("ignores a non-workerd navigator and still picks scrypt on Node", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });

    expect(selectPasswordAlgorithm()).toBe("scrypt");
  });

  it("falls back to pbkdf2 on an unknown runtime (no navigator, no process)", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("process", undefined);

    expect(selectPasswordAlgorithm()).toBe("pbkdf2");
  });

  it("falls back to pbkdf2 when process carries no node version", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("process", { versions: {} });

    expect(selectPasswordAlgorithm()).toBe("pbkdf2");
  });
});

describe("hashPassword facade — runtime-adaptive minting, prefix-dispatched verify", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints scrypt on Node and round-trips through the facade", async () => {
    const stored = await hashPassword("node password");

    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("node password", stored)).toBe(true);
    expect(needsRehash(stored)).toBe(false);
  });

  it("mints pbkdf2 when the runtime selects it (workerd), and round-trips", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

    const stored = await hashPassword("edge password");

    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("edge password", stored)).toBe(true);
    expect(needsRehash(stored)).toBe(false);
  });

  it("verify dispatches on the stored prefix regardless of runtime", async () => {
    // A pbkdf2 hash verifies on Node (no stub) — the edge-minted hash is portable.
    const web = await pbkdf2Hash("portable", 1000);
    expect(await verifyPassword("portable", web)).toBe(true);
    expect(needsRehash(web)).toBe(true); // 1000 < 600000

    // A scrypt hash routes to the scrypt backend.
    const scryptStored = await hashPasswordScrypt("scrypt password");
    expect(await verifyPassword("scrypt password", scryptStored)).toBe(true);
    expect(needsRehash(scryptStored)).toBe(false);
  });

  it("fails closed (never throws) on a well-formed scrypt hash whose N is over-cost", async () => {
    // N=2^19 is a valid power of two we never mint; deriving it would exceed MAXMEM
    // and throw. parseStored must reject it up front so verify resolves false.
    const overCost = `scrypt$${2 ** 19}$8$1$${hexOf(16)}$${hexOf(64)}`;

    expect(await verifyPassword("anything", overCost)).toBe(false);
    expect(needsRehash(overCost)).toBe(false);
  });
});

// A VALID cheap scrypt hash of a known password (N=2): if the guard failed to fire,
// the scrypt backend would run and return `true` — so asserting a throw proves the
// refusal happens BEFORE the KDF, not that the hash merely failed to verify.
const scryptHashOf = (password: string): string => {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 2, r: 8, p: 1 });

  return `scrypt$2$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
};

describe("verifyPassword — refuses scrypt on a runtime that cannot run it", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws AUTH_KDF_UNAVAILABLE for a scrypt hash on the edge, without running scrypt", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

    const stored = scryptHashOf("correct password");

    await expect(verifyPassword("correct password", stored)).rejects.toMatchObject({
      name: "AuthError",
      code: "AUTH_KDF_UNAVAILABLE",
    });
    // Belt: it is an AuthError, and it carries the offending algorithm for the caller.
    await verifyPassword("correct password", stored).catch((error: unknown) => {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).details).toMatchObject({ algorithm: "scrypt" });
    });
  });

  it("still verifies a scrypt hash on Node — the guard does not fire on a scrypt host", async () => {
    const stored = scryptHashOf("correct password");

    expect(await verifyPassword("correct password", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });
});
