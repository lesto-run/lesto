import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { envField, PUBLIC_ENV_DEFINE_KEY } from "@lesto/env";
import type { ClientSchema } from "@lesto/env";

import { CliError } from "../src/errors";
import type * as BinModule from "../src/bin";
import type * as RunModule from "../src/run";

/**
 * The bin's `env.client.ts` resolution seam (`resolvePublicEnvDefine` +
 * `clientDefineFromModule`) — the PUBLIC_* inject-map builder, and the red-team fix
 * that turns a MISAUTHORED `env.client.ts` (present, but no `clientEnv` export) into a
 * loud coded error instead of a silently-skipped inline (L-a779d2aa).
 *
 * `bin.ts` is the executable wiring: it calls `run()` and then `process.exit()` at module
 * scope, and — because `bin/lesto.mjs` IMPORTS it under node (jiti) — it cannot be
 * import-guarded (`import.meta.main` is unset on the node path) without breaking that
 * loader. So to unit-test its exported logic we import it with those two side effects
 * neutralized: `run` mocked to a resolved no-op, and `process.exit` stubbed BEFORE the
 * dynamic import evaluates the module body.
 */

vi.mock("../src/run", async (importOriginal) => {
  const actual = await importOriginal<typeof RunModule>();

  return { ...actual, run: () => Promise.resolve(0) };
});

describe("env.client.ts resolution seam", () => {
  let clientDefineFromModule: typeof BinModule["clientDefineFromModule"];
  let resolvePublicEnvDefine: typeof BinModule["resolvePublicEnvDefine"];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Stub BEFORE the import: bin.ts runs `process.exit(code)` at module scope for a
    // non-serve/dev argv, which under vitest would tear down the worker.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const bin = await import("../src/bin");

    clientDefineFromModule = bin.clientDefineFromModule;
    resolvePublicEnvDefine = bin.resolvePublicEnvDefine;
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  it("throws a coded CLI_ENV_CLIENT_NO_EXPORT when the module has no `clientEnv` export", () => {
    // A misauthored `env.client.ts`: the file loaded (an author clearly intended public
    // config) but forgot `export const clientEnv`. The OLD code returned `undefined` here
    // → no inlining → the island silently shipped unreplaced PUBLIC_* refs. It must now
    // fail loud + coded. (Revert the `throw` in `clientDefineFromModule` to `return
    // undefined` and this assertion goes RED — the fix is exactly this throw.)
    let thrown: unknown;

    try {
      clientDefineFromModule({});
      expect.unreachable("a module with no `clientEnv` export must throw");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe("CLI_ENV_CLIENT_NO_EXPORT");
    // The message must name the missing export so the author knows the exact fix.
    expect((thrown as CliError).message).toContain("clientEnv");
    expect((thrown as CliError).message).toContain("env.client.ts");
    // It carries the offending path in `details` for the wrapped build-failure report.
    expect((thrown as CliError).details["path"]).toMatch(/env\.client\.ts$/);
  });

  it("also throws when `clientEnv` is explicitly `undefined` (a re-export of nothing)", () => {
    // A PRESENT-but-undefined key (`export { clientEnv }` where it's undefined) — the
    // guard is `=== undefined`, so it's refused the same as an absent key. The double
    // assertion is only to model that shape under `exactOptionalPropertyTypes`.
    const module = { clientEnv: undefined } as unknown as { clientEnv?: ClientSchema };

    expect(() => clientDefineFromModule(module)).toThrowError(
      expect.objectContaining({ code: "CLI_ENV_CLIENT_NO_EXPORT" }),
    );
  });

  it("returns the PUBLIC_* define map when the module exports a valid `clientEnv`", () => {
    // A `.default(...)` field so the map builds off the schema alone, with no PUBLIC_*
    // var set in the build-time environment.
    const map = clientDefineFromModule({
      clientEnv: { PUBLIC_API_BASE: envField.string().default("https://api.example.com") },
    });

    expect(Object.keys(map)).toStrictEqual([PUBLIC_ENV_DEFINE_KEY]);
    // The inlined bag is a JSON literal carrying the resolved public value.
    expect(map[PUBLIC_ENV_DEFINE_KEY]).toContain("PUBLIC_API_BASE");
    expect(map[PUBLIC_ENV_DEFINE_KEY]).toContain("https://api.example.com");
  });

  it("resolvePublicEnvDefine yields undefined when the project has no env.client.ts", async () => {
    // The absent-file path is the still-valid "app with no public config" case: the
    // `dirExists` guard short-circuits before any import. The CLI package root (the
    // test's cwd) declares no `env.client.ts`, so the real resolver returns undefined.
    await expect(resolvePublicEnvDefine()).resolves.toBeUndefined();
  });
});
