import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@playwright/test";

/**
 * Shared scaffold-install helpers, factored OUT of `scaffold-real-install.spec.ts` so a second
 * spec (`scaffold-hoisted-preflight.spec.ts`, L-513dd8a6) can reuse the exact pack/pin/build
 * mechanics WITHOUT importing that spec — importing a `.spec.ts` would execute its `test.describe`
 * blocks as a side effect and register them into the importer's run. These functions are pure IO
 * helpers with NO top-level test registration, so they are safe to import from any spec.
 *
 * `packLestoClosure` and `pinAppToTarballs` are copied VERBATIM from `scaffold-real-install.spec.ts`
 * (leg b's current-tree tarball reconstruction); keep the two in sync if either is touched.
 */

/** Repo root, resolved from this module's location (`packages/e2e/` → `../..`). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The in-repo `create-lesto` bin — the working-tree scaffold generator. */
export const CREATE_LESTO_BIN = join(REPO_ROOT, "packages", "create-lesto", "src", "bin.ts");

/** The app's own installed `lesto` bin (a node shim; run under `bun` so `Bun.build` is defined). */
export function lestoBin(appDir: string): string {
  return join(appDir, "node_modules", ".bin", "lesto");
}

/** Assert `out/client.js` is the Preact island bundle — never drags React's server renderer. */
export async function assertPreactClient(appDir: string): Promise<void> {
  const source = await readFile(join(appDir, "out", "client.js"), "utf8");

  expect(source).not.toContain("renderToReadableStream");
  expect(source).not.toContain("renderToStaticMarkup");
}

/**
 * Pack every PUBLIC `@lesto/*` package (+ create-lesto) to `vendor` and return a
 * `{ name → "file:<tarball>" }` map — the registry stand-in (mirrors `scripts/pack-and-boot.mjs`).
 * `bun pm pack` rewrites each `workspace:*` to the exact version, exactly like a publish.
 */
export function packLestoClosure(repoRoot: string, vendor: string): Record<string, string> {
  const packagesDir = join(repoRoot, "packages");

  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    if (JSON.parse(readFileSync(manifestPath, "utf8")).private === true) continue;

    // Quiet stdout; let bun's stderr through so a pack failure names its cause.
    execFileSync("bun", ["pm", "pack", "--destination", vendor], {
      cwd: join(packagesDir, dir),
      stdio: ["ignore", "ignore", "inherit"],
    });
  }

  const overrides: Record<string, string> = {};

  for (const tarball of readdirSync(vendor).filter((file) => file.endsWith(".tgz"))) {
    // Read the packaged name from the tarball's own manifest (robust to filename mangling).
    const meta = JSON.parse(
      execFileSync("tar", ["-xzOf", join(vendor, tarball), "package/package.json"], {
        encoding: "utf8",
      }),
    ) as { name: string };

    overrides[meta.name] = `file:${join(vendor, tarball)}`;
  }

  return overrides;
}

/**
 * Repin the app's DIRECT `@lesto/*` deps onto the tarballs AND set package.json `overrides` to the
 * full tarball map — the overrides reach the TRANSITIVE `@lesto/*` graph the tarballs declare.
 * Without them bun would resolve those transitive refs from the registry (published 0.1.1),
 * masking the current tree — the exact silent substitution this leg exists to prevent.
 */
export async function pinAppToTarballs(
  appDir: string,
  overrides: Record<string, string>,
): Promise<void> {
  const manifestPath = join(appDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = manifest[field];
    if (deps === undefined) continue;

    for (const dep of Object.keys(deps)) {
      if (dep in overrides) deps[dep] = overrides[dep] as string;
    }
  }

  manifest.overrides = overrides;

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
