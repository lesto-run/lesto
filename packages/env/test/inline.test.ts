import { describe, expect, it } from "vitest";

import { PUBLIC_ENV_GLOBAL } from "../src/client";
import type { EnvError } from "../src/errors";
import { envField } from "../src/fields";
import { clientDefineMap, PUBLIC_ENV_DEFINE_KEY } from "../src/inline";

describe("clientDefineMap", () => {
  it("inlines the PUBLIC subset as a single global-replacing define entry", () => {
    const map = clientDefineMap(
      { PUBLIC_API_BASE: envField.string(), PUBLIC_RETRIES: envField.number().default(3) },
      { PUBLIC_API_BASE: "https://api" },
    );

    // One key — the global the runtime reader reads — and the value is a JSON object
    // literal of the validated public values (typed: a number stays a number).
    expect(Object.keys(map)).toEqual([PUBLIC_ENV_DEFINE_KEY]);
    expect(PUBLIC_ENV_DEFINE_KEY).toBe(`globalThis.${PUBLIC_ENV_GLOBAL}`);

    const parsed = JSON.parse(map[PUBLIC_ENV_DEFINE_KEY] as string) as Record<string, unknown>;

    expect(parsed).toEqual({ PUBLIC_API_BASE: "https://api", PUBLIC_RETRIES: 3 });
  });

  it("produces an empty bag for an empty schema", () => {
    const map = clientDefineMap({}, {});

    expect(JSON.parse(map[PUBLIC_ENV_DEFINE_KEY] as string)).toEqual({});
  });

  it("refuses a non-PUBLIC key (validation runs first) with ENV_CLIENT_NOT_PUBLIC", () => {
    let thrown: unknown;

    try {
      clientDefineMap({ SECRET: envField.string() }, { SECRET: "x" });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as EnvError).code).toBe("ENV_CLIENT_NOT_PUBLIC");
  });

  it("fails the build the same coded way a boot does when a PUBLIC var is missing", () => {
    let thrown: unknown;

    try {
      clientDefineMap({ PUBLIC_REQUIRED: envField.string() }, {});
    } catch (error) {
      thrown = error;
    }

    expect((thrown as EnvError).code).toBe("ENV_VALIDATION_FAILED");
  });
});
