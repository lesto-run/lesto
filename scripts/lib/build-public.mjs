// Build the public `@lesto/*` surface to `dist/` with tsup — the counterpart to the
// publish-shape rewrite in `pack-public.mjs`. The in-repo dev loop runs TS from `src`; a
// PUBLISHED package must ship built `dist/*.js` + `.d.ts` (a plain-node/webpack/wrangler
// consumer cannot import raw `.ts` from `node_modules`). So the pack path (gate + release)
// calls `buildAll` first, then `rewriteManifestForPublish` (pack-public.mjs) points `exports`
// at the artifacts this produced.
//
// `deriveEntries` is PURE (unit-tested); `buildAll` and `packAllBuiltToVendor` are effectful
// (spawn tsup/bun, read/write `dist/`) and — like `readTarballMeta` — are guarded by CI running
// `test:pack-boot` + `test:pack-import` against every package, not by a unit test.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rewriteManifestForPublish, srcTargetToDist } from "./pack-public.mjs";

// The shared tsup config every package build is pointed at (via `--config`). Its ONLY job is
// `removeNodeProtocol: false`, so tsup PRESERVES the `node:` prefix on builtin specifiers rather
// than stripping it (its default) — the framework uses `node:` deliberately for edge safety (a CF
// Worker on older `nodejs_compat` won't resolve a bare `async_hooks`/`crypto`; a browser bundler
// can mis-resolve bare `crypto` to the deprecated npm shim). This first-class option REPLACED a
// post-build regex codemod that re-added `node:` by scanning dist — the codemod was blind to
// lexical context and could have rewritten a builtin name inside a string/template literal in a
// codegen package (`@lesto/cli`, `create-lesto`); the build-tool option cannot misfire. (L-2c592379.)
const TSUP_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "tsup.public.config.ts");

/**
 * The `src` entry files tsup must build for a package, derived from its manifest so the build and
 * the {@link rewriteManifestForPublish} exports rewrite can never disagree about which files exist:
 * every `./src/*` target across the whole `exports` tree (deduped), plus `src/bin.ts` for a package
 * that ships an executable (both bin shims — `@lesto/cli`, `create-lesto` — jiti-import `../src/bin.ts`,
 * which is NOT an export and so would otherwise never be built).
 *
 * @param {{exports?:any, bin?:any}} manifest a parsed package.json
 * @returns {string[]} package-relative entry paths (e.g. `"src/index.ts"`), sorted for determinism
 */
export function deriveEntries(manifest) {
  const entries = new Set();
  const walk = (node) => {
    if (typeof node === "string") {
      if (/^(?:\.\/)?src\//.test(node)) entries.add(node.replace(/^\.\//, ""));
    } else if (node && typeof node === "object") {
      for (const value of Object.values(node)) walk(value);
    }
  };
  if (manifest.exports !== undefined) walk(manifest.exports);
  if (manifest.bin !== undefined && manifest.bin !== null) entries.add("src/bin.ts");
  return [...entries].toSorted();
}

/**
 * Build every package in `dirs` into its (gitignored) `dist/` with tsup — ESM only (every package
 * is `type: module`; no package declares a `require`/CJS condition), `.d.ts` emitted, deps
 * auto-externalized. FAILS CLOSED: after each build, asserts every entry produced both a
 * `dist/<name>.js` and `dist/<name>.d.ts`, so a silent tsup miss can never be packed as an empty
 * `dist/`. Builds are independent (dts resolves dependency types from sibling `src`, runtime deps
 * are external), so order does not matter.
 *
 * @param {string} packagesDir absolute path to `packages/`
 * @param {string[]} dirs directory names to build (from {@link readPublicPackageDirs})
 * @throws {Error} if a build fails or an expected `dist` artifact is absent
 */
export function buildAll(packagesDir, dirs) {
  for (const dir of dirs) {
    const pkgDir = join(packagesDir, dir);
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const entries = deriveEntries(manifest);
    if (entries.length === 0) continue;

    try {
      execFileSync(
        "bunx",
        ["tsup", ...entries, "--config", TSUP_CONFIG, "--format", "esm", "--dts", "--target", "es2023", "--clean", "--silent"],
        { cwd: pkgDir, stdio: ["ignore", "ignore", "inherit"] },
      );
    } catch (error) {
      throw new Error(`tsup build failed for packages/${dir}`, { cause: error });
    }

    for (const entry of entries) {
      // `srcTargetToDist` fails closed on a non-flat/non-src entry — the same mapping the exports
      // rewrite uses, so "what we build" and "what exports point at" stay identical by construction.
      const { js, dts } = srcTargetToDist(entry);
      for (const out of [js, dts]) {
        if (!existsSync(join(pkgDir, out))) {
          throw new Error(`tsup did not emit ${out} for ${manifest.name} (entry ${basename(entry)})`);
        }
      }
    }
    // NB: the `node:` prefix on builtin specifiers is PRESERVED by the `removeNodeProtocol: false`
    // in TSUP_CONFIG above — no post-build rewrite needed. (L-2c592379.)
  }
}

/** name → version for EVERY workspace package (public + private), so any `workspace:` edge resolves. */
function readWorkspaceVersions(packagesDir) {
  const versions = {};
  for (const dir of readdirSync(packagesDir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
      if (manifest.name) versions[manifest.name] = manifest.version;
    } catch {
      // not a package dir — skip
    }
  }
  return versions;
}

/**
 * Pack every dir in `dirs` in its PUBLISHED (built) shape — the pack-time-swap counterpart to
 * `packAllToVendor`. For each package: {@link buildAll} to `dist/`, stage a copy carrying only the
 * publishable files (`dist/`, plus `bin/` and README/LICENSE when present) with a
 * {@link rewriteManifestForPublish} manifest (exports→dist, `workspace:` ranges→concrete), then
 * `bun pm pack` from the STAGING dir. Staging is required because `bun pm pack` only rewrites
 * `workspace:*` from inside the workspace — from a staged dir it errors on the protocol, so we
 * pre-rewrite the ranges ourselves.
 *
 * The sole packer for the public surface — all three callers (the import gate, `pack-and-boot`,
 * `publish`) use it, so the published shape they cover is identical by construction. Returns the
 * emitted `.tgz` filenames (pass to {@link readTarballMeta}) with the same count guard the callers
 * expect.
 *
 * @param {string} packagesDir absolute path to `packages/`
 * @param {string[]} dirs directory names to pack
 * @param {string} vendor absolute path to the (already-created) vendor output dir
 * @returns {string[]} the emitted `.tgz` filenames in `vendor`
 * @throws {Error} if a build fails, a pack fails, or the tarball count != `dirs.length`
 */
export function packAllBuiltToVendor(packagesDir, dirs, vendor) {
  const versionMap = readWorkspaceVersions(packagesDir);
  buildAll(packagesDir, dirs);

  const stageRoot = join(dirname(vendor), "stage");
  for (const dir of dirs) {
    const pkgDir = join(packagesDir, dir);
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const stage = join(stageRoot, dir);
    mkdirSync(stage, { recursive: true });

    // Only the publishable files land in the staged tarball root. `dist/` always; `bin/` for an
    // executable package; README/LICENSE for publish fidelity (npm auto-includes them).
    cpSync(join(pkgDir, "dist"), join(stage, "dist"), { recursive: true });
    if (manifest.bin !== undefined && existsSync(join(pkgDir, "bin"))) {
      cpSync(join(pkgDir, "bin"), join(stage, "bin"), { recursive: true });
    }
    for (const name of readdirSync(pkgDir)) {
      if (/^(readme|license)/i.test(name)) cpSync(join(pkgDir, name), join(stage, name));
    }

    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify(rewriteManifestForPublish(manifest, versionMap), null, 2)}\n`,
    );

    try {
      execFileSync("bun", ["pm", "pack", "--destination", vendor], {
        cwd: stage,
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch (error) {
      throw new Error(`bun pm pack failed for staged packages/${dir}`, { cause: error });
    }
  }

  const tarballs = readdirSync(vendor).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== dirs.length) {
    throw new Error(`packed ${tarballs.length} tarballs, expected ${dirs.length}`);
  }
  return tarballs;
}
