import { describe, expect, it, vi } from "vitest";

import { defineEnv } from "../src/define";
import { EnvError } from "../src/errors";
import { envField } from "../src/fields";
import { defineSplitEnv, isPublicName, isServerContext, PUBLIC_PREFIX } from "../src/split";

describe("isPublicName", () => {
  it("accepts PUBLIC_-prefixed names with a real suffix", () => {
    expect(isPublicName("PUBLIC_API_BASE")).toBe(true);
    expect(isPublicName(`${PUBLIC_PREFIX}X`)).toBe(true);
  });

  it("rejects a non-prefixed name and the bare prefix", () => {
    expect(isPublicName("API_BASE")).toBe(false);
    expect(isPublicName("PUBLIC_")).toBe(false);
    expect(isPublicName("")).toBe(false);
  });
});

describe("isServerContext", () => {
  it("honors an explicit override either way", () => {
    expect(isServerContext(true)).toBe(true);
    expect(isServerContext(false)).toBe(false);
  });

  it("is server under Node (no window/document)", () => {
    expect(isServerContext()).toBe(true);
  });

  it("is NOT server when a window/document exists (the browser)", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});

    try {
      expect(isServerContext()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("defineSplitEnv", () => {
  const source = {
    DATABASE_URL: "postgres://db",
    SESSION_SECRET: "shh",
    PUBLIC_API_BASE: "https://api.example.com",
  };

  it("validates both halves and merges them into a frozen object (server context)", () => {
    const env = defineSplitEnv(
      {
        server: { DATABASE_URL: envField.string(), SESSION_SECRET: envField.string() },
        client: { PUBLIC_API_BASE: envField.string() },
      },
      source,
      true,
    );

    expect(env.DATABASE_URL).toBe("postgres://db");
    expect(env.SESSION_SECRET).toBe("shh");
    expect(env.PUBLIC_API_BASE).toBe("https://api.example.com");
  });

  it("refuses a misnamed client key with a coded ENV_CLIENT_NOT_PUBLIC (built-time)", () => {
    let thrown: unknown;

    try {
      defineSplitEnv({ client: { API_BASE: envField.string() } }, source, true);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvError);
    expect((thrown as EnvError).code).toBe("ENV_CLIENT_NOT_PUBLIC");
    expect((thrown as EnvError).message).toContain('"API_BASE"');
    expect((thrown as EnvError).message).toContain("PUBLIC_*");
    expect((thrown as EnvError).details["keys"]).toEqual(["API_BASE"]);
  });

  it("lists EVERY misnamed client key (plural noun)", () => {
    let thrown: EnvError | undefined;

    try {
      defineSplitEnv(
        { client: { API_BASE: envField.string(), SECRET_KEY: envField.string() } },
        source,
        true,
      );
    } catch (error) {
      thrown = error as EnvError;
    }

    expect(thrown?.message).toContain("keys");
    expect(thrown?.details["keys"]).toEqual(["API_BASE", "SECRET_KEY"]);
  });

  it("THROWS ENV_SERVER_LEAK when a server key is read in a browser context", () => {
    const env = defineSplitEnv(
      {
        server: { SESSION_SECRET: envField.string() },
        client: { PUBLIC_API_BASE: envField.string() },
      },
      source,
      false, // browser
    );

    // The public key reads fine in the browser…
    expect(env.PUBLIC_API_BASE).toBe("https://api.example.com");

    // …but the server secret throws LOUD + EARLY (the first read), naming the var.
    let thrown: unknown;

    try {
      void env.SESSION_SECRET;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvError);
    expect((thrown as EnvError).code).toBe("ENV_SERVER_LEAK");
    expect((thrown as EnvError).message).toContain('"SESSION_SECRET"');
    expect((thrown as EnvError).details["key"]).toBe("SESSION_SECRET");
  });

  it("auto-detects the browser context when no override is given (guard fires)", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});

    try {
      const env = defineSplitEnv({ server: { SECRET: envField.string() } }, { SECRET: "x" });

      expect(() => env.SECRET).toThrow(EnvError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not guard a non-string / symbol property access", () => {
    const env = defineSplitEnv({ server: { SECRET: envField.string() } }, { SECRET: "x" }, false);

    // A symbol key (e.g. Symbol.toPrimitive during coercion) is not a server var name,
    // so the guard ignores it — the Proxy passes it straight through.
    expect((env as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });

  it("treats empty halves as valid (server-only or client-only or neither)", () => {
    expect(defineSplitEnv({}, {}, true)).toEqual({});
    expect(defineSplitEnv({ server: { A: envField.string() } }, { A: "1" }, true).A).toBe("1");
  });
});

describe("defineEnv dispatch to the split shape", () => {
  it("routes a { server, client } schema through the split guard", () => {
    const env = defineEnv(
      {
        server: { SECRET: envField.string() },
        client: { PUBLIC_FLAG: envField.boolean().default(false) },
      },
      { SECRET: "x" },
    );

    expect(env.SECRET).toBe("x");
    expect(env.PUBLIC_FLAG).toBe(false);
  });

  it("routes a CLIENT-ONLY schema (no server half) through the split guard", () => {
    // `server` is undefined here, so the dispatch's first `||` clause short-circuits
    // and the `client` clause is what flags the split shape.
    const env = defineEnv({ client: { PUBLIC_X: envField.string() } }, { PUBLIC_X: "v" });

    expect(env.PUBLIC_X).toBe("v");
  });

  it("still reads a FLAT schema with a var literally named `server` as flat (back-compat)", () => {
    // A flat schema whose value at `server` is an EnvField is NOT the split shape —
    // the dispatch keys off the value being a non-field record, so this stays flat.
    const env = defineEnv({ server: envField.string() }, { server: "literal" });

    expect(env.server).toBe("literal");
  });

  it("reads a FLAT schema with a var literally named `client` as flat (back-compat)", () => {
    // The mirror case: a flat `client` field (an EnvField) is not the split shape.
    const env = defineEnv({ client: envField.string() }, { client: "literal" });

    expect(env.client).toBe("literal");
  });
});
