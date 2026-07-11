/**
 * `shouldSwallowMissingExport` — the pure classifier extracted out of the
 * coverage-excluded `vite-build.ts` bundler edge (same reason `collect-artifacts.ts` is
 * split out) so the swallow/escalate decision is unit-tested directly.
 *
 * The crux assertion is the escalation case: a genuine user typo reports the identical
 * `MISSING_EXPORT` warning shape as the one contained hack (`React.use` off
 * `preact/compat`) — confirmed against REAL Rollup warning objects (see the module doc
 * on `missing-export.ts`), not just its `.d.ts`. Before this predicate existed,
 * `vite-build.ts`'s `onwarn` swallowed EVERY `MISSING_EXPORT` unconditionally, so a
 * typo's `binding`/`exporter` never mattered — the equivalent of this predicate always
 * returning `true` for `code === "MISSING_EXPORT"`. The tests below pin the NARROWED
 * contract: only the exact contained shape swallows; every other binding or exporter,
 * including ones that only differ from the contained case by binding or by exporter,
 * must return `false` so `vite-build.ts`'s `onwarn` forwards it to `defaultHandler`.
 */

import type { Rollup } from "vite";
import { describe, expect, it } from "vitest";

import { shouldSwallowMissingExport } from "../src/missing-export";

/** A `MISSING_EXPORT` `RollupLog`, defaulted to the exact contained hack's real shape. */
function missingExportWarning(overrides: Partial<Rollup.RollupLog> = {}): Rollup.RollupLog {
  return {
    code: "MISSING_EXPORT",
    binding: "use",
    exporter: "/repo/node_modules/preact/compat/dist/compat.module.js",
    message: '"use" is not exported by "preact/compat"',
    ...overrides,
  };
}

describe("shouldSwallowMissingExport", () => {
  it("swallows the contained React.use-off-preact/compat case", () => {
    expect(shouldSwallowMissingExport(missingExportWarning())).toBe(true);
  });

  it("swallows regardless of which conditional export preact/compat resolved to", () => {
    // `import`/`require` conditions resolve to `.mjs`/`.js` rather than the browser
    // `.module.js` asserted above — the package-subpath match must not be tied to one.
    expect(
      shouldSwallowMissingExport(
        missingExportWarning({ exporter: "/repo/node_modules/preact/compat/dist/compat.mjs" }),
      ),
    ).toBe(true);
  });

  it("escalates a genuine typo with a different binding off the SAME exporter", () => {
    // `ns.typo` (or an unreferenced `import { typo }`) reports the identical shape as
    // the contained case except for `binding` — proven against a real Rollup warning
    // object (see missing-export.ts's doc); this is the case a blanket
    // `code === "MISSING_EXPORT"` swallow could never distinguish.
    expect(shouldSwallowMissingExport(missingExportWarning({ binding: "typo" }))).toBe(false);
  });

  it("escalates use missing from an exporter that is not preact/compat", () => {
    expect(
      shouldSwallowMissingExport(
        missingExportWarning({ exporter: "/repo/node_modules/some-lib/dist/index.js" }),
      ),
    ).toBe(false);
  });

  it("escalates a typo with neither the contained binding nor the contained exporter", () => {
    expect(
      shouldSwallowMissingExport(
        missingExportWarning({
          binding: "typo",
          exporter: "/repo/src/app/islands/widget.tsx",
        }),
      ),
    ).toBe(false);
  });

  it("does not swallow a preact/compat-like path that is not actually the package (near-miss guard)", () => {
    // A bare substring match on "preact/compat" would false-positive on an unrelated
    // package sharing the prefix; the anchored regex must reject it.
    expect(
      shouldSwallowMissingExport(
        missingExportWarning({ exporter: "/repo/node_modules/preact/compat-widgets/index.js" }),
      ),
    ).toBe(false);
  });

  it("never swallows when exporter is undefined", () => {
    expect(shouldSwallowMissingExport(missingExportWarning({ exporter: undefined }))).toBe(false);
  });

  it("leaves every non-MISSING_EXPORT warning to escalate untouched", () => {
    expect(
      shouldSwallowMissingExport({
        code: "CIRCULAR_DEPENDENCY",
        message: "circular dependency",
      }),
    ).toBe(false);
  });
});
