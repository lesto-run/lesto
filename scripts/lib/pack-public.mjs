// Single source of truth for the PUBLIC PACKAGE CLOSURE that the release
// (`scripts/publish.mjs`) and the install-and-boot proof (`scripts/pack-and-boot.mjs`)
// both operate on. The two scripts MUST pack — and therefore cover — the exact same set of
// packages, or they diverge in the worst way: a package the boot-proof validates but publish
// never ships, or one publish ships but the boot-proof never proves installs. Previously each
// script inlined a byte-identical copy of the filter + pack loop + count guard + tarball
// meta-read, kept in agreement only by a hand-written "must match the other script" comment.
// Extracting them here makes that invariant CONSTRUCTION-enforced: there is exactly one filter,
// one pack loop, one count guard, and one meta-reader, so the two callers cannot drift apart.
//
// Everything below is a behaviour-preserving extraction — identical shell commands, iteration
// order, stdio wiring, and error messages/shapes as the original inlined blocks. Only the RAW
// reads are shared; each caller derives its own view from `readTarballMeta` (publish builds a
// name → {path, version} map; pack-and-boot builds the npm `overrides` + packed-version +
// cross-reference tables), so that caller-specific derivation stays in the callers.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The publishable package directories under `packagesDir`: every `packages/<dir>` whose
 * `package.json` exists and is NOT `private: true` (the de-privatized closure plus
 * `create-lesto`). Version-agnostic — each package's own version is its source of truth, so a
 * coordinated bump needs no edit here.
 *
 * @param {string} packagesDir absolute path to the repo's `packages/` directory
 * @returns {string[]} directory names (relative to `packagesDir`), in `readdirSync` order
 */
export function readPublicPackageDirs(packagesDir) {
  return readdirSync(packagesDir).filter((name) => {
    const pj = join(packagesDir, name, "package.json");
    if (!existsSync(pj)) return false;
    return JSON.parse(readFileSync(pj, "utf8")).private !== true;
  });
}

/**
 * Pack every dir in `dirs` into `vendor` with `bun pm pack` — which rewrites each `workspace:*`
 * dep to the exact version in the emitted tarball, exactly as a real publish would — then guard
 * that the emitted tarball count matches. stdout is silenced but bun's stderr is let through so
 * a pack failure names its cause.
 *
 * @param {string} packagesDir absolute path to `packages/`
 * @param {string[]} dirs directory names to pack (from {@link readPublicPackageDirs})
 * @param {string} vendor absolute path to the (already-created) vendor output dir
 * @returns {string[]} the emitted `.tgz` filenames in `vendor` (`readdirSync` order)
 * @throws {Error} if any `bun pm pack` fails, or the emitted tarball count != `dirs.length`
 */
export function packAllToVendor(packagesDir, dirs, vendor) {
  for (const dir of dirs) {
    try {
      execFileSync("bun", ["pm", "pack", "--destination", vendor], {
        cwd: join(packagesDir, dir),
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch (error) {
      throw new Error(`bun pm pack failed for packages/${dir}`, { cause: error });
    }
  }

  const tarballs = readdirSync(vendor).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== dirs.length) {
    throw new Error(`packed ${tarballs.length} tarballs, expected ${dirs.length}`);
  }
  return tarballs;
}

/**
 * Read each `.tgz` in `vendor` and parse its OWN `package/package.json` (robust to
 * scope/filename mangling). Returns the raw path + parsed-meta pairs; each caller derives its
 * own view (publish → name → {path, version}; pack-and-boot → overrides/packedVersion/crossRefs).
 *
 * @param {string} vendor absolute path to the vendor dir holding the packed tarballs
 * @returns {{path:string, meta:any}[]} one entry per `.tgz`, in `readdirSync` order
 */
export function readTarballMeta(vendor) {
  return readdirSync(vendor)
    .filter((file) => file.endsWith(".tgz"))
    .map((tgz) => {
      const path = join(vendor, tgz);
      const meta = JSON.parse(
        execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" }),
      );
      return { path, meta };
    });
}
