import { afterEach, describe, expect, it, vi } from "vitest";

import { defineClientEnv, PUBLIC_ENV_GLOBAL } from "../src/client";
import { EnvError } from "../src/errors";
import { envField } from "../src/fields";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defineClientEnv", () => {
  it("validates a PUBLIC_ schema from an explicit source", () => {
    const env = defineClientEnv(
      { PUBLIC_API_BASE: envField.string(), PUBLIC_FLAG: envField.boolean().default(false) },
      { PUBLIC_API_BASE: "https://api" },
    );

    expect(env.PUBLIC_API_BASE).toBe("https://api");
    expect(env.PUBLIC_FLAG).toBe(false);
  });

  it("refuses a non-PUBLIC key with ENV_CLIENT_NOT_PUBLIC", () => {
    let thrown: unknown;

    try {
      defineClientEnv({ API_BASE: envField.string() }, { API_BASE: "x" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvError);
    expect((thrown as EnvError).code).toBe("ENV_CLIENT_NOT_PUBLIC");
    expect((thrown as EnvError).message).toContain('"API_BASE"');
    expect((thrown as EnvError).details["keys"]).toEqual(["API_BASE"]);
  });

  it("uses plural noun for multiple misnamed keys", () => {
    let thrown: EnvError | undefined;

    try {
      defineClientEnv({ A: envField.string(), B: envField.string() }, {});
    } catch (error) {
      thrown = error as EnvError;
    }

    expect(thrown?.message).toContain("keys");
    expect(thrown?.details["keys"]).toEqual(["A", "B"]);
  });

  it("reads the bundler-injected global when present (browser path)", () => {
    // The island bundler writes the inlined public bag to this global; the reader
    // prefers it over process.env so the SAME call works in a built browser bundle.
    vi.stubGlobal(PUBLIC_ENV_GLOBAL, { PUBLIC_API_BASE: "https://injected" });

    const env = defineClientEnv({ PUBLIC_API_BASE: envField.string() });

    expect(env.PUBLIC_API_BASE).toBe("https://injected");
  });

  it("falls back to process.env when the injected global is absent (server dev/SSR)", () => {
    vi.stubGlobal(PUBLIC_ENV_GLOBAL, undefined);
    vi.stubGlobal("process", { env: { PUBLIC_API_BASE: "https://from-process" } });

    const env = defineClientEnv({ PUBLIC_API_BASE: envField.string() });

    expect(env.PUBLIC_API_BASE).toBe("https://from-process");
  });

  it("falls back to {} when neither the global nor process exists (the edge)", () => {
    vi.stubGlobal(PUBLIC_ENV_GLOBAL, undefined);
    vi.stubGlobal("process", undefined);

    // No source at all — the optional field resolves to its default.
    const env = defineClientEnv({ PUBLIC_FLAG: envField.boolean().default(true) });

    expect(env.PUBLIC_FLAG).toBe(true);
  });
});
