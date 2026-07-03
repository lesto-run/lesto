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
 * subpath `@lesto/ui/client` → `@lesto/ui`), and assert each is in the scaffold's declared-dep
 * set. The declared set is a LOCAL mirror of create-lesto's `LESTO_PACKAGES` (this package must
 * not depend on create-lesto); the last test proves the guard bites — drop `@lesto/observability`
 * from the mirror and the subset invariant flags the emitted `@lesto/observability` as undeclared,
 * the precise red this test would have shown before the fix.
 */

/**
 * The `@lesto/*` runtime packages a scaffolded app declares — a local mirror of
 * `LESTO_PACKAGES` in `packages/create-lesto/src/templates.ts`. Keep in sync if that list
 * changes; the subset invariant below is what makes a drift between "what the entry imports"
 * and "what the scaffold declares" a red unit test rather than a masked install failure.
 *
 * KNOWN GAP (fail-open in ONE direction): this catches the ADD direction — a new bare import
 * with no matching declared package goes red (the exact `3fd4941` shape). It does NOT catch the
 * REMOVE direction: if `LESTO_PACKAGES` ever drops a package `synthesizeEntry` still imports while
 * this mirror keeps it, the subset check stays green and only the nightly e2e catches the break.
 * Closing that needs the mirror mechanically tied to the real list (relocate to create-lesto's
 * test suite against the real `LESTO_PACKAGES`, or a `readFileSync` cross-check) — tracked as a
 * follow-up; the mirror is a deliberate stopgap because `@lesto/assets` must not depend on create-lesto.
 */
const SCAFFOLD_DECLARED_PACKAGES: ReadonlySet<string> = new Set([
  "@lesto/cli",
  "@lesto/assets",
  "@lesto/cloudflare",
  "@lesto/db",
  "@lesto/env",
  "@lesto/kernel",
  "@lesto/migrate",
  "@lesto/observability",
  "@lesto/runtime",
  "@lesto/sites",
  "@lesto/styles",
  "@lesto/ui",
  "@lesto/web",
]);

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

// A representative spread: an eager island, a lazy (dynamic-import) island, and the dev/prod +
// RUM-sample-rate knobs — so the parse covers every static-import shape the synthesizer emits.
const eager: IslandFile = { name: "Account", importPath: "/app/islands/account.tsx", lazy: false, ssr: false };
const lazy: IslandFile = { name: "Chart", importPath: "/app/islands/chart.tsx", lazy: true, ssr: false };

describe("synthesized entry — every bare specifier is a scaffold-declared package", () => {
  it.each([
    ["eager only", synthesizeEntry([eager])],
    ["lazy only", synthesizeEntry([lazy])],
    ["mixed eager + lazy", synthesizeEntry([eager, lazy])],
    ["no islands", synthesizeEntry([])],
    ["dev entry (page-refresh hook)", synthesizeEntry([eager], { dev: true })],
    ["prod entry with a RUM sample rate", synthesizeEntry([eager], {}, { sampleRate: 0.25 })],
  ])("%s: imports only declared packages", (_label, source) => {
    const undeclared = [...importedPackages(source)].filter(
      (pkg) => !SCAFFOLD_DECLARED_PACKAGES.has(pkg),
    );

    expect(undeclared).toEqual([]);
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

  it("the guard BITES: a declared set missing @lesto/observability flags the omission", () => {
    // Model the pre-3fd4941 scaffold — the declared set WITHOUT @lesto/observability. The
    // subset check then flags the emitted `@lesto/observability` as undeclared: the precise
    // red this unit test would have shown long before the isolated-install e2e caught it.
    const withoutObservability = new Set(SCAFFOLD_DECLARED_PACKAGES);
    withoutObservability.delete("@lesto/observability");

    const undeclared = [...importedPackages(synthesizeEntry([eager]))].filter(
      (pkg) => !withoutObservability.has(pkg),
    );

    expect(undeclared).toContain("@lesto/observability");
  });
});
