import { describe, expect, it } from "vitest";

import { rumImport } from "../src/rum-client";
import { synthesizeEntry } from "../src/synthesize";
import type { IslandFile } from "../src/synthesize";

/**
 * Assets-INTERNAL invariants of the synthesized island entry (`synthesizeEntry`, the `/client.js`
 * a scaffolded app ships): it ALWAYS statically imports the two runtime packages the app resolves
 * at its own root — `@lesto/ui` (Registry + the client hydration runtime) and `@lesto/observability`
 * (the `@lesto/observability/rum` browser-RUM subpath, ARCHITECTURE.md §7). These are
 * `@lesto/assets`' own emit contract; `@lesto/observability` is the exact dep whose omission
 * `3fd4941` carried.
 *
 * The CROSS-PACKAGE subset guard — that every `@lesto/*` specifier the entry emits is a member of
 * the scaffold's declared `LESTO_PACKAGES`, in BOTH drift directions — now lives in create-lesto's
 * own suite (`packages/create-lesto/test/specifier-subset.test.ts`), where both sides are typed
 * PUBLIC exports (the authoritative `LESTO_PACKAGES` is a typed import, `synthesizeEntry` is one of
 * ours) — retiring the test-time source parse this file used to carry.
 */

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

// A representative eager island — the fixture the kept invariants synthesize from.
const eager: IslandFile = {
  name: "Account",
  importPath: "/app/islands/account.tsx",
  lazy: false,
  ssr: false,
};

describe("synthesized entry — statically imports the UI + RUM runtime packages", () => {
  it("statically imports @lesto/ui AND @lesto/observability (the RUM package the omission dropped)", () => {
    const packages = importedPackages(synthesizeEntry([eager]));

    // `@lesto/ui` (Registry + the client hydration runtime) and `@lesto/observability`
    // (`@lesto/observability/rum` → startBrowserRum) are BOTH always statically imported — the
    // assets-internal emit contract. That both are ALSO scaffold-declared is the cross-package
    // subset guard, now asserted in create-lesto's specifier-subset test.
    expect(packages.has("@lesto/ui")).toBe(true);
    expect(packages.has("@lesto/observability")).toBe(true);
  });

  it("ties the RUM import to @lesto/observability (rumImport is the emitted specifier)", () => {
    // The entry's RUM line comes from `rumImport()`; its specifier reduces to the package the
    // scaffold must declare. If the RUM subpath ever moves packages, this catches the drift.
    const rumSpecifier = staticBareSpecifiers(rumImport())[0] as string;

    expect(rumSpecifier).toBe("@lesto/observability/rum");
    expect(packageOf(rumSpecifier)).toBe("@lesto/observability");
  });
});
