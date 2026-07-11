/**
 * `failOnMissingExport` — the fatal escalation extracted out of the
 * coverage-excluded `vite-build.ts` bundler edge (same reason `collect-artifacts.ts`
 * is split out) so the throw/pass-through decision is unit-tested directly.
 *
 * The contract these tests pin: EVERY `MISSING_EXPORT` warning is now fatal —
 * including the shape that USED to be contained and swallowed (`React.use` off
 * `preact/compat`). Step 1 of this change removed the only legitimate producer of
 * that shape (the resolver now carries React's `use` through a server-only seam,
 * so nothing reads `use` off the aliased namespace), so a `binding: "use"` off
 * `preact/compat` is now just another genuine miss and must throw like any other.
 * Every non-`MISSING_EXPORT` code returns untouched so `vite-build.ts` forwards it
 * to Rollup's `defaultHandler`.
 */

import type { Rollup } from "vite";
import { describe, expect, it } from "vitest";

import { AssetsError } from "../src/errors";
import { failOnMissingExport } from "../src/missing-export";

/** A `MISSING_EXPORT` `RollupLog`, defaulted to the ex-contained hack's real shape. */
function missingExportWarning(overrides: Partial<Rollup.RollupLog> = {}): Rollup.RollupLog {
  return {
    code: "MISSING_EXPORT",
    binding: "use",
    exporter: "/repo/node_modules/preact/compat/dist/compat.module.js",
    message: '"use" is not exported by "preact/compat"',
    ...overrides,
  };
}

describe("failOnMissingExport", () => {
  it("throws for the ex-contained React.use-off-preact/compat shape — now fatal too", () => {
    // This exact shape was the ONE case the old `shouldSwallowMissingExport`
    // swallowed. Step 1 removed its only producer, so it must now throw like any
    // other miss — the crux of making MISSING_EXPORT fatal.
    try {
      failOnMissingExport(missingExportWarning());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).code).toBe("ASSETS_BUNDLE_FAILED");
      // The failure names the exact binding + module that missed.
      expect((error as AssetsError).details).toEqual({
        binding: "use",
        exporter: "/repo/node_modules/preact/compat/dist/compat.module.js",
      });
      expect((error as AssetsError).message).toContain("use");
      expect((error as AssetsError).message).toContain("preact/compat");
    }
  });

  it("throws for a genuine typo of the same shape (different binding, same exporter)", () => {
    // `ns.typo` (or an unreferenced `import { typo }`) reports the identical
    // MISSING_EXPORT shape as the ex-contained case except for `binding` — the
    // case the old blanket swallow shipped to prod as `undefined`.
    expect(() => failOnMissingExport(missingExportWarning({ binding: "typo" }))).toThrow(
      AssetsError,
    );
  });

  it("throws for a miss off any other exporter (a user island module)", () => {
    expect(() =>
      failOnMissingExport(
        missingExportWarning({ binding: "typo", exporter: "/repo/src/app/islands/widget.tsx" }),
      ),
    ).toThrow(AssetsError);
  });

  it("throws even when exporter is undefined, still naming the binding in details", () => {
    try {
      failOnMissingExport(missingExportWarning({ exporter: undefined }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).details).toEqual({ binding: "use", exporter: undefined });
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
