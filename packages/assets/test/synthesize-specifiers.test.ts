import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { rumImport } from "../src/rum-client";
import { synthesizeEntry } from "../src/synthesize";
import type { IslandFile } from "../src/synthesize";

/**
 * The pit-of-success guard that the e2e install smoke (`packages/e2e/scaffold-real-install.spec.ts`)
 * exists to back up — as a PURE unit test, so the invariant fails RED in milliseconds instead of
 * only surfacing in a real registry install.
 *
 * `synthesizeEntry` writes the island hydration entry a scaffolded app ships as its `/client.js`.
 * Every STATIC BARE specifier that entry imports (`@lesto/ui`, `@lesto/ui/client`,
 * `@lesto/observability/rum`, …) must be a package the scaffold DECLARES as a dependency —
 * otherwise the app imports a package it never installed, which a HOISTING install silently
 * masks (a transitive copy resolves the bare specifier) but bun's isolated linker, pnpm strict,
 * or Yarn PnP hard-fail on. That mask is exactly what hid the `@lesto/observability` omission
 * until `3fd4941` carried it: the synthesized entry ALWAYS emits `@lesto/observability/rum`
 * (browser RUM — ARCHITECTURE.md §7), but the scaffold's dep list did not carry it.
 *
 * So: parse the bare specifiers the entry emits, reduce each to its package name (a scoped
 * subpath `@lesto/ui/client` → `@lesto/ui`), and assert each `@lesto/*` package is in the
 * scaffold's declared-dep set. That declared set is the REAL `LESTO_PACKAGES` from
 * `packages/create-lesto/src/templates.ts`, read + parsed at test time (see
 * {@link realLestoPackages}) — NOT a hand-copied mirror — so BOTH drift directions fail here as
 * a unit test: a new import with no declared package (ADD), AND a package DROPPED from the real
 * list that the entry still imports (REMOVE). The old hand-mirror only caught ADD; a REMOVE
 * slipped through to the nightly e2e. The two `… goes RED …` tests below prove each direction bites.
 */

/**
 * The URL of create-lesto's `templates.ts`, resolved relative to THIS test file (not the cwd),
 * so the read works whether vitest runs from the repo root or the package dir.
 */
const TEMPLATES_SOURCE_URL = new URL("../../create-lesto/src/templates.ts", import.meta.url);

/**
 * The REAL `@lesto/*` runtime packages a scaffolded app declares — parsed at test time straight
 * from create-lesto's `export const LESTO_PACKAGES = [ … ] as const;`, NOT a hand-copied mirror.
 *
 * `@lesto/assets` must never take a runtime dependency on create-lesto (and, under bun's isolated
 * linker, cannot even resolve it at test runtime), so a TEST-ONLY `readFileSync` + strict source
 * parse is how the authoritative list is reached. This mechanically ties the subset guard to the
 * real list: DROP a package from `LESTO_PACKAGES` that the synthesized entry still imports and the
 * check below goes RED here — closing the remove-direction fail-open the old mirror left to the
 * nightly e2e.
 *
 * The parse is deliberately STRICT so it can never pass vacuously:
 *   - comments are stripped FIRST, so a package name surviving ONLY inside a `// dropped
 *     "@lesto/foo"` comment does NOT read as a declared member — that comment-survival is exactly
 *     how the remove-direction leak would silently reopen;
 *   - a missing `LESTO_PACKAGES` block, or a parse that yields an EMPTY list, THROWS (red) rather
 *     than letting the subset check pass against nothing.
 */
function realLestoPackages(): Set<string> {
  const source = readFileSync(TEMPLATES_SOURCE_URL, "utf8");

  const block = source.match(/export const LESTO_PACKAGES\s*=\s*\[([\s\S]*?)\]\s*as const;/);

  if (block === null) {
    throw new Error(
      "could not locate `export const LESTO_PACKAGES = [ … ] as const;` in create-lesto's " +
        "templates.ts — the authoritative-list parse in synthesize-specifiers.test.ts is stale",
    );
  }

  const members = (block[1] as string)
    // Strip comments FIRST: a package name that lives only in a comment (e.g. a `// dropped
    // "@lesto/foo"` note) must NOT count as declared — that is the remove-direction leak.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const packages = [...members.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

  if (packages.length === 0) {
    throw new Error(
      "parsed an EMPTY LESTO_PACKAGES from create-lesto's templates.ts — the parse regex is " +
        "stale; refusing to let the subset guard pass vacuously",
    );
  }

  return new Set(packages);
}

/**
 * The scaffold's declared `@lesto/*` runtime dependency set — the AUTHORITATIVE list, parsed
 * once from the real source (not a mirror the test could let drift out of sync).
 */
const SCAFFOLD_DECLARED_PACKAGES: ReadonlySet<string> = realLestoPackages();

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
// RUM-sample-rate knobs — so the parse covers every static-import shape the synthesizer emits.
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

describe("synthesized entry — every bare specifier is a scaffold-declared package", () => {
  it("parses a non-empty authoritative LESTO_PACKAGES carrying the UI + RUM packages", () => {
    // Prove the source parse actually worked — non-empty, and carrying the two packages the
    // synthesized entry always imports. A parse that silently produced an empty (or wrong) set
    // would make the subset check below pass vacuously; this test is what stops that.
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
    // Authoritative check: every `@lesto/*` specifier the entry emits ∈ the REAL LESTO_PACKAGES.
    expect(undeclaredLestoPackages(source, SCAFFOLD_DECLARED_PACKAGES)).toEqual([]);

    // And the entry emits NO non-`@lesto/*` bare specifier today. `undeclaredLestoPackages` only
    // vets the `@lesto/*` half against LESTO_PACKAGES; a future bare `preact`/`react` import the
    // scaffold might not declare would slip THAT check silently (fail-open to the nightly e2e). This
    // holds the other half of the namespace red until someone consciously decides — the whole point.
    const nonLesto = [...importedPackages(source)].filter((pkg) => !pkg.startsWith("@lesto/"));
    expect(nonLesto).toEqual([]);
  });

  it("statically imports @lesto/ui AND @lesto/observability (the RUM package the omission dropped)", () => {
    const packages = importedPackages(synthesizeEntry([eager]));

    // `@lesto/ui` (Registry + the client hydration runtime) and `@lesto/observability`
    // (`@lesto/observability/rum` → startBrowserRum) are BOTH always imported — and both
    // must be scaffold-declared. The second is the exact dep whose omission this test guards.
    expect(packages.has("@lesto/ui")).toBe(true);
    expect(packages.has("@lesto/observability")).toBe(true);
    expect(SCAFFOLD_DECLARED_PACKAGES.has("@lesto/observability")).toBe(true);
  });

  it("ties the RUM import to @lesto/observability (rumImport is the emitted specifier)", () => {
    // The entry's RUM line comes from `rumImport()`; its specifier reduces to the package the
    // scaffold must declare. If the RUM subpath ever moves packages, this catches the drift.
    const rumSpecifier = staticBareSpecifiers(rumImport())[0] as string;

    expect(rumSpecifier).toBe("@lesto/observability/rum");
    expect(packageOf(rumSpecifier)).toBe("@lesto/observability");
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
    // imports `@lesto/observability/rum`); model the REAL LESTO_PACKAGES with @lesto/observability
    // DROPPED — as if a refactor removed it from create-lesto. Tied to the real list, the subset
    // check now flags it as a UNIT test, where the old hand-mirror stayed green and only the
    // nightly isolated-install e2e caught the break.
    expect(SCAFFOLD_DECLARED_PACKAGES.has("@lesto/observability")).toBe(true); // not vacuous

    const listMissingObservability = new Set(SCAFFOLD_DECLARED_PACKAGES);
    listMissingObservability.delete("@lesto/observability");

    expect(
      undeclaredLestoPackages(synthesizeEntry([eager]), listMissingObservability),
    ).toContain("@lesto/observability");
  });
});
