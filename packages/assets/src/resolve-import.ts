/**
 * Cross-runtime resolution of a framework runtime import against an app's `node_modules` — the
 * probe behind `buildClient`'s RUM preflight ({@link file://./build-client.ts}).
 *
 * The preflight seam runs on BOTH the Bun dev-fallback build AND the `viteBuildClientDeps`
 * production build, and the production `lesto build`/`lesto deploy` runs under **plain Node** (the
 * jiti `lesto` bin, `#!/usr/bin/env node`) as well as Bun. So the probe MUST NOT touch a `Bun`
 * global — `Bun.resolveSync` throws a `ReferenceError` under Node, which a `catch` would misread as
 * "dependency missing" and refuse a build whose dep is correctly installed.
 *
 * A pure `node_modules` walk is the runtime-agnostic answer and is also layout-agnostic — hoisted,
 * Bun/pnpm isolated (symlinked `node_modules`), and workspace layouts all place a package's
 * `package.json` under some ancestor directory's `node_modules`, and `existsSync` follows the
 * symlink. The recurring failure this guards (bit create-lesto, @prefresh, and www) is the package
 * being **absent** from an isolated per-app layout; presence is exactly what the walk detects.
 *
 * It deliberately checks PACKAGE presence, not the exact export subpath: honoring an `exports` map's
 * conditions cross-runtime without a real resolver is fragile, and if the package is installed its
 * own (correct) `exports` map governs the subpath. A present-but-wrong-version package (missing the
 * `./rum` subpath) is a far rarer case, and the bundler's error there names the subpath rather than
 * failing opaquely — so package presence is the right, robust proxy.
 */

import { dirname, join } from "node:path";

/**
 * The package a bare import specifier belongs to: `@scope/name/sub` → `@scope/name`,
 * `pkg/sub` → `pkg`. (A bare `pkg` or `@scope/name` returns itself.)
 */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");

  return specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0]!;
}

/**
 * Walk up from `fromDir` looking for the specifier's package under a `node_modules` — returning the
 * package directory when found, or `undefined` when no ancestor holds it. `exists` is injected (real
 * impl: `node:fs` `existsSync`) so the walk is unit-tested with no disk. The walk stops at the
 * filesystem root (`dirname(dir) === dir`), so it always terminates.
 */
export function resolveInstalledPackage(
  specifier: string,
  fromDir: string,
  exists: (path: string) => boolean,
): string | undefined {
  const pkg = packageNameOf(specifier);
  let dir = fromDir;

  for (;;) {
    const packageDir = join(dir, "node_modules", pkg);

    if (exists(join(packageDir, "package.json"))) return packageDir;

    const parent = dirname(dir);

    if (parent === dir) return undefined;

    dir = parent;
  }
}
