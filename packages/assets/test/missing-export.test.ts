/**
 * `failOnMissingExport` — the fatal escalation extracted out of the
 * coverage-excluded `vite-build.ts` bundler edge (same reason `collect-artifacts.ts`
 * is split out) so the throw/downgrade decision is unit-tested directly.
 *
 * The contract these tests pin: a `MISSING_EXPORT` written in FIRST-PARTY source
 * is FATAL (a genuine `ns.typo` must not ship as `undefined`), INCLUDING a typo
 * against a `node_modules` dependency — the common case, whose EXPORTER is under
 * `node_modules` but whose IMPORTER is the app's own island. A miss whose importer
 * lives under `node_modules` is a dependency's own guarded-optional access and is
 * left a plain warning (forwarded to `defaultHandler`), so a third-party
 * feature-probe never fails the app build. Every non-`MISSING_EXPORT` code returns
 * untouched.
 */

import type { Rollup } from "vite";
import { describe, expect, it } from "vitest";

import { AssetsError } from "../src/errors";
import { failOnMissingExport } from "../src/missing-export";

const FIRST_PARTY_ISLAND = "/repo/src/app/islands/widget.tsx";
const UI_DEP = "/repo/node_modules/@lesto/ui/dist/index.js";
const PREACT_COMPAT = "/repo/node_modules/preact/compat/dist/compat.module.js";

/**
 * A `MISSING_EXPORT` `RollupLog`. Defaults to the COMMON real-world case the
 * escalation exists for: the app's own island reads a name a `node_modules`
 * dependency does not export. `id` is the importer (the code doing the access),
 * `exporter` the module lacking the name — both confirmed populated on a real
 * rollup@4 warning object.
 */
function missingExportWarning(overrides: Partial<Rollup.RollupLog> = {}): Rollup.RollupLog {
  return {
    code: "MISSING_EXPORT",
    binding: "typo",
    exporter: UI_DEP,
    id: FIRST_PARTY_ISLAND,
    message: '"typo" is not exported by "@lesto/ui"',
    ...overrides,
  };
}

describe("failOnMissingExport", () => {
  it("throws (ASSETS_MISSING_EXPORT) for a first-party typo against a node_modules dependency", () => {
    // The load-bearing case: the miss is authored in the app's own island, but the
    // EXPORTER is a node_modules package (the common shape — most imports are deps).
    // Scoping on the exporter would wrongly DOWNGRADE this and re-ship the typo as
    // `undefined`; scoping on the importer keeps it fatal. Names binding+exporter+importer.
    try {
      failOnMissingExport(missingExportWarning());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).code).toBe("ASSETS_MISSING_EXPORT");
      expect((error as AssetsError).details).toEqual({
        binding: "typo",
        exporter: UI_DEP,
        importer: FIRST_PARTY_ISLAND,
      });
      expect((error as AssetsError).message).toContain("typo");
      expect((error as AssetsError).message).toContain("@lesto/ui");
    }
  });

  it("throws for a first-party miss off another first-party module", () => {
    expect(() =>
      failOnMissingExport(
        missingExportWarning({ exporter: "/repo/src/app/shared/util.ts", binding: "gone" }),
      ),
    ).toThrow(AssetsError);
  });

  it("does NOT throw for a miss written inside a node_modules dependency — left a warning", () => {
    // A third-party lib's deliberate guarded-optional access (`ns.maybe ?? shim`)
    // against a module that genuinely lacks the member. The lib handles the
    // `undefined` at runtime; failing the APP build over it is a false positive.
    const depWarning = missingExportWarning({
      id: "/repo/node_modules/some-lib/dist/index.js",
      binding: "useMaybe",
      exporter: PREACT_COMPAT,
    });
    expect(() => failOnMissingExport(depWarning)).not.toThrow();
    // Positive assertion of the downgrade branch: returns undefined, so
    // `vite-build.ts` falls through to `defaultHandler(warning)`.
    expect(failOnMissingExport(depWarning)).toBeUndefined();
  });

  it("downgrades the ex-contained React.use-off-preact/compat shape when a dependency produces it", () => {
    // The one historical live producer was `@lesto/ui`'s define-island reading
    // `React.use` — i.e. a node_modules importer. Step 1 removed it; were it to
    // recur from any dependency, it is that dependency's concern, not fatal.
    expect(
      failOnMissingExport(
        missingExportWarning({
          id: PREACT_COMPAT.replace("compat.module.js", "hooks.js"),
          binding: "use",
          exporter: PREACT_COMPAT,
        }),
      ),
    ).toBeUndefined();
  });

  it("stays FATAL when the importer cannot be identified (id absent) — downgrade only on proven third-party authorship", () => {
    expect(() => failOnMissingExport(missingExportWarning({ id: undefined }))).toThrow(AssetsError);
  });

  it("treats a first-party path that merely contains 'node_modules' as a filename part as first-party (fatal)", () => {
    // `/node_modules/` is slash-bounded, so `node_modules_shim.ts` is NOT a
    // dependency — a real first-party miss there must still fail the build.
    expect(() =>
      failOnMissingExport(missingExportWarning({ id: "/repo/src/node_modules_shim.ts" })),
    ).toThrow(AssetsError);
  });

  it("throws even when exporter is undefined, still naming the binding + importer in details", () => {
    try {
      failOnMissingExport(missingExportWarning({ exporter: undefined }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).details).toEqual({
        binding: "typo",
        exporter: undefined,
        importer: FIRST_PARTY_ISLAND,
      });
    }
  });

  it("returns undefined (does not throw) for a non-MISSING_EXPORT code — forwarded to defaultHandler", () => {
    const otherWarning: Rollup.RollupLog = {
      code: "CIRCULAR_DEPENDENCY",
      message: "circular dependency",
    };

    expect(() => failOnMissingExport(otherWarning)).not.toThrow();
    // Positive assertion of the pass-through branch: the early return yields
    // `undefined`, so `vite-build.ts` falls through to `defaultHandler(warning)`.
    expect(failOnMissingExport(otherWarning)).toBeUndefined();
  });
});
