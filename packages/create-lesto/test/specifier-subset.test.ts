import { describe, expect, it } from "vitest";

import { rumImport, synthesizeEntry } from "@lesto/assets";
import type { IslandFile } from "@lesto/assets";

import { LESTO_PACKAGES } from "../src/templates";

/**
 * The pit-of-success subset guard the isolated-install e2e (`packages/e2e/scaffold-real-install.spec.ts`)
 * backs up — as a PURE unit test, so the invariant fails RED in milliseconds instead of only
 * surfacing in a real registry install.
 *
 * `@lesto/assets`' `synthesizeEntry` writes the island hydration entry a scaffolded app ships as
 * its `/client.js`. Every STATIC BARE `@lesto/*` specifier that entry imports (`@lesto/ui`,
 * `@lesto/ui/client`, `@lesto/observability/rum`, …) MUST be a package the scaffold DECLARES in its
 * dependency list — otherwise the app imports a package it never installed, which a HOISTING install
 * silently masks (a transitive copy resolves the bare specifier) but bun's isolated linker, pnpm
 * strict, or Yarn PnP hard-fail on. That mask is exactly what hid the `@lesto/observability`
 * omission until `3fd4941` carried it: the synthesized entry ALWAYS emits `@lesto/observability/rum`
 * (browser RUM — ARCHITECTURE.md §7), but the scaffold's dep list did not carry it.
 *
 * This guard lives HERE in create-lesto (not in `@lesto/assets`) because BOTH sides are typed PUBLIC
 * exports — no source is regex-parsed: the authoritative {@link LESTO_PACKAGES} is a TYPED import
 * from create-lesto's own `templates.ts` (a rename becomes a COMPILE error here — the whole point),
 * and `synthesizeEntry`/`rumImport` are public exports of `@lesto/assets`, a test-only devDep
 * (`@lesto/assets` never depends on create-lesto, so there is no cycle). The real list is EVALUATED,
 * so BOTH drift directions fail as a unit test — a new import with no declared package (ADD), AND a
 * package DROPPED from the real list that the entry still imports (REMOVE). The old approach parsed
 * the list out of create-lesto's source from inside `@lesto/assets`; typed public exports retire
 * that parse. The two `… goes RED …` tests below prove each direction bites.
 */

/**
 * The scaffold's declared `@lesto/*` runtime dependency set — the AUTHORITATIVE list, EVALUATED
 * from create-lesto's typed `LESTO_PACKAGES` export (not a hand-mirror, and not a source parse).
 */
const SCAFFOLD_DECLARED_PACKAGES: ReadonlySet<string> = new Set<string>(LESTO_PACKAGES);

/**
 * The static, BARE module specifiers a synthesized entry imports.
 *
 * Matches the `import … from "x"` and side-effect `import "x"` forms only — a dynamic
 * `import("x")` (how a lazy island is reached) carries no `from` and is skipped, and the
 * `[^;]` bound stops a match from crossing a statement boundary. "Bare" excludes the island
 * modules the entry static-imports by path (`/app/islands/*` / `./*`), which are not packages.
 */
function staticBareSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  for (const match of source.matchAll(/\bimport\b[^;]*?\bfrom\s*"([^"]+)"/g)) {
    specifiers.push(match[1] as string);
  }

  for (const match of source.matchAll(/\bimport\s+"([^"]+)"/g)) {
    specifiers.push(match[1] as string);
  }

  return specifiers.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/"));
}

/** Reduce a specifier to its package name — a scoped subpath `@scope/name/sub` → `@scope/name`. */
function packageOf(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] as string);
}

/** The set of PACKAGE names a synthesized entry statically imports, bare specifiers only. */
function importedPackages(source: string): Set<string> {
  return new Set(staticBareSpecifiers(source).map(packageOf));
}

/**
 * The `@lesto/*` packages `source` statically imports that are NOT in `declared`.
 *
 * Scoped to `@lesto/*` because `LESTO_PACKAGES` (the authoritative list) is the `@lesto/*`
 * runtime set — a future non-`@lesto` bare import (e.g. `react`) is declared elsewhere in the
 * manifest and is not this guard's concern. An empty result means every `@lesto/*` specifier the
 * entry emits is a package the scaffold declares. Both red-path tests drive this helper: the ADD
 * direction varies `source` against the real `declared`; the REMOVE direction varies `declared`
 * against a real `source`.
 */
function undeclaredLestoPackages(source: string, declared: ReadonlySet<string>): string[] {
  return [...importedPackages(source)].filter(
    (pkg) => pkg.startsWith("@lesto/") && !declared.has(pkg),
  );
}

// A representative spread: an eager island, a lazy (dynamic-import) island, and the dev/prod +
// RUM-sample-rate knobs — so the scan covers every static-import shape the synthesizer emits.
const eager: IslandFile = {
  name: "Account",
  importPath: "/app/islands/account.tsx",
  lazy: false,
  ssr: false,
};
const lazy: IslandFile = {
  name: "Chart",
  importPath: "/app/islands/chart.tsx",
  lazy: true,
  ssr: false,
};

describe("synthesized entry — every @lesto/* specifier is a scaffold-declared package", () => {
  it("declares a non-empty LESTO_PACKAGES carrying the UI + RUM packages", () => {
    // The subset check below is only meaningful if the declared set is real and non-empty — an
    // empty set would let it pass vacuously. `LESTO_PACKAGES` is a TYPED, EVALUATED import (not a
    // parse), and it must carry the two packages the synthesized entry always imports.
    expect(SCAFFOLD_DECLARED_PACKAGES.size).toBeGreaterThan(0);
    expect(SCAFFOLD_DECLARED_PACKAGES.has("@lesto/ui")).toBe(true);
    expect(SCAFFOLD_DECLARED_PACKAGES.has("@lesto/observability")).toBe(true);
  });

  it.each([
    ["eager only", synthesizeEntry([eager])],
    ["lazy only", synthesizeEntry([lazy])],
    ["mixed eager + lazy", synthesizeEntry([eager, lazy])],
    ["no islands", synthesizeEntry([])],
    ["dev entry (page-refresh hook)", synthesizeEntry([eager], { dev: true })],
    ["prod entry with a RUM sample rate", synthesizeEntry([eager], {}, { sampleRate: 0.25 })],
  ])("%s: imports only declared @lesto/* packages", (_label, source) => {
    // Authoritative subset: every `@lesto/*` specifier the entry emits ∈ the REAL LESTO_PACKAGES.
    expect(undeclaredLestoPackages(source, SCAFFOLD_DECLARED_PACKAGES)).toEqual([]);

    // And the entry emits NO non-`@lesto/*` bare specifier today. `undeclaredLestoPackages` only
    // vets the `@lesto/*` half against LESTO_PACKAGES; a future bare `preact`/`react` import the
    // scaffold might not declare would slip THAT check silently (fail-open to the nightly e2e).
    // This holds the other half of the namespace red until someone consciously decides.
    const nonLesto = [...importedPackages(source)].filter((pkg) => !pkg.startsWith("@lesto/"));
    expect(nonLesto).toEqual([]);
  });

  it("ADD direction goes RED: an emitted specifier with no declared package is flagged", () => {
    // Hold the REAL declared list fixed; model a NEW bare import the synthesizer might grow that
    // no scaffold package declares. The base entry is clean (proves the fixture isn't already
    // red), and injecting the undeclared import flips the authoritative check — the `3fd4941` shape.
    const base = synthesizeEntry([eager]);
    expect(undeclaredLestoPackages(base, SCAFFOLD_DECLARED_PACKAGES)).toEqual([]);

    const withUndeclaredImport = `${base}\nimport { thing } from "@lesto/not-a-real-package";\n`;

    expect(undeclaredLestoPackages(withUndeclaredImport, SCAFFOLD_DECLARED_PACKAGES)).toContain(
      "@lesto/not-a-real-package",
    );
  });

  it("REMOVE direction goes RED: dropping a still-imported package from the real list is flagged", () => {
    // The precise fail-open this guard closes. Hold the REAL synthesized entry fixed (it still
    // imports `@lesto/observability/rum` via `rumImport()`); model the REAL LESTO_PACKAGES with
    // @lesto/observability DROPPED — as if a refactor removed it from create-lesto. Tied to the
    // real evaluated list, the subset check now flags it as a UNIT test, where a hand-mirror would
    // stay green and only the nightly isolated-install e2e caught the break.
    expect(SCAFFOLD_DECLARED_PACKAGES.has("@lesto/observability")).toBe(true); // not vacuous

    // The entry's RUM line comes from `rumImport()` and still emits `@lesto/observability/rum`, so
    // dropping the package from the declared list MUST flag it (guards against a vacuous REMOVE).
    expect(staticBareSpecifiers(rumImport())).toContain("@lesto/observability/rum");

    const listMissingObservability = new Set(SCAFFOLD_DECLARED_PACKAGES);
    listMissingObservability.delete("@lesto/observability");

    expect(undeclaredLestoPackages(synthesizeEntry([eager]), listMissingObservability)).toContain(
      "@lesto/observability",
    );
  });
});
