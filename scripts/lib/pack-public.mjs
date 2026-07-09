// Single source of truth for the PUBLIC PACKAGE CLOSURE that the release
// (`scripts/publish.mjs`), the install-and-boot proof (`scripts/pack-and-boot.mjs`), and the
// plain-node import gate (`scripts/pack-and-import.mjs`) all operate on. They MUST cover the exact
// same set of packages, or they diverge in the worst way: a package a proof validates but publish
// never ships, or one publish ships but no proof ever installs. `readPublicPackageDirs` (here) is
// the one filter they share, so they cannot drift apart. The build+stage+pack loop that turns that
// set into published-shape (`dist`) tarballs is `packAllBuiltToVendor` in `scripts/lib/build-public.mjs`
// (it lives there because it depends on `buildAll`/`rewriteManifestForPublish`; splitting it out of
// this file also avoids a circular import). This module keeps the CLOSURE filter + the tarball
// meta-reader; each caller derives its own view from `readTarballMeta` (publish builds a
// name → {path, version} map; pack-and-boot builds the npm `overrides` + packed-version +
// cross-reference tables), so that caller-specific derivation stays in the callers.
//
// TESTING: `readPublicPackageDirs` is fs-only (readdir + read manifests, no subprocess), so it IS
// unit-tested directly against a hermetic temp dir in `scripts/publish.test.mjs`, and the PURE
// publish-shape logic (`srcTargetToDist`/`rewriteManifestForPublish` below, `deriveEntries` in
// build-public.mjs) is unit-tested in `scripts/build-public.test.mjs`. `readTarballMeta` (tar) and
// the effectful `packAllBuiltToVendor`/`buildAll` spawn real subprocesses, so — like the inline
// blocks they replaced — they are NOT unit-tested; their standing guard is CI running both
// `test:pack-boot` and `test:pack-import` against every real package. (`publish.mjs` runs ONLY on
// the release `workflow_dispatch`; its use of these helpers is proven transitively, since they are
// the identical functions the two proofs drive.)

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
 * Parse each packed tarball's OWN `package/package.json` (robust to scope/filename mangling).
 * Takes the `.tgz` filenames the packer (`packAllBuiltToVendor`) already listed — so the vendor dir
 * is read exactly once across the pack + meta step, not twice — and returns the raw path +
 * parsed-meta pairs; each caller derives its own view (publish → name → {path, version};
 * pack-and-boot → overrides/packedVersion/crossRefs).
 *
 * @param {string} vendor absolute path to the vendor dir holding the packed tarballs
 * @param {string[]} tarballs the `.tgz` filenames in `vendor` (from the packer)
 * @returns {{path:string, meta:any}[]} one entry per tarball, in the given order
 */
export function readTarballMeta(vendor, tarballs) {
  return tarballs.map((tgz) => {
    const path = join(vendor, tgz);
    const meta = JSON.parse(
      execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" }),
    );
    return { path, meta };
  });
}

// ---------------------------------------------------------------------------
// PUBLISH-SHAPE REWRITE (0.1.6+): the in-repo `exports` point at TS source
// (`./src/*.ts`) so the dev loop runs source with no build; a PUBLISHED package
// must instead point at built `dist/*.js` + `.d.ts`, because a plain-node /
// webpack / wrangler consumer cannot import raw `.ts` from `node_modules`
// (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Rather than diverge the two
// manifests in-repo (which would re-wire every dev-loop resolver — jiti, bun,
// 67 vitest configs, tsc), we keep `src` in-repo and transform the manifest to
// its `dist` shape at PACK time. `rewriteManifestForPublish` is that transform:
// a pure function, unit-tested to 100%, applied to a staged copy just before
// `bun pm pack`. Because the gate (`pack-and-import.mjs`) and the release
// (`publish.mjs`) both pack through this one helper, the gate validates exactly
// the shape publish ships.
//
// NOTE this ALSO subsumes the `workspace:*` → exact-version rewrite `bun pm pack`
// used to do for us: bun only rewrites the protocol when packing from INSIDE the
// workspace, but the swap packs from a staged dir OUTSIDE it (where bun errors on
// `workspace:*`), so we must rewrite the ranges ourselves here.

/**
 * Map one flat `./src/<name>.ts[x]` export target to its built `dist` counterparts. The
 * whole published surface is flat (`./src/index.ts`, `./src/policy.ts`, `./src/react.tsx`, …
 * — no nested targets), and tsup emits a flat `dist/<name>.js` + `dist/<name>.d.ts`; this
 * function encodes that 1:1 mapping and FAILS CLOSED on anything it can't map (a nested or
 * non-`src` target), so a future export shape that would silently mis-resolve is caught here
 * instead of shipping broken.
 *
 * @param {string} target e.g. `"./src/react.tsx"` or `"src/index.ts"`
 * @returns {{js:string, dts:string}} the `./dist/<name>.js` (runtime) and `./dist/<name>.d.ts` (types) paths
 * @throws {Error} if `target` is not a flat `src` TypeScript file
 */
export function srcTargetToDist(target) {
  const match = /^(?:\.\/)?src\/([^/]+)\.(?:m|c)?tsx?$/.exec(target);
  if (!match) {
    throw new Error(
      `cannot map export target to dist (expected a flat ./src/<name>.ts[x]): ${target}`,
    );
  }
  const base = match[1];
  return { js: `./dist/${base}.js`, dts: `./dist/${base}.d.ts` };
}

/** Rewrite an `exports` tree, sending the `types` condition to `.d.ts` and every other (runtime) condition to `.js`. */
function rewriteExportsToDist(node, isTypes) {
  if (typeof node === "string") {
    // Only `./src/*` leaves are ours to build; leave anything else (e.g. an already-`./dist`
    // target, or a bare `"./package.json"` export) exactly as authored.
    if (!/^(?:\.\/)?src\//.test(node)) return node;
    const { js, dts } = srcTargetToDist(node);
    return isTypes ? dts : js;
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      // Subpath keys ("."/"./server") inherit the parent's type-ness; `types` flips it on;
      // every other key is a runtime condition (→ `.js`).
      const childIsTypes = key === "types" ? true : key.startsWith(".") ? isTypes : false;
      out[key] = rewriteExportsToDist(value, childIsTypes);
    }
    return out;
  }
  return node;
}

/** Rewrite one dependency range: `workspace:*`→exact, `workspace:^`→`^ver`, `workspace:~`→`~ver`, `workspace:<v>`→`<v>`; leave registry ranges alone. */
function rewriteDepRange(name, range, versionMap) {
  if (!range.startsWith("workspace:")) return range;
  const spec = range.slice("workspace:".length);
  const version = versionMap[name];
  if (version === undefined) {
    throw new Error(`workspace dependency ${name} (${range}) has no version in the workspace map`);
  }
  if (spec === "*" || spec === "") return version;
  if (spec === "^") return `^${version}`;
  if (spec === "~") return `~${version}`;
  return spec; // an explicit `workspace:1.2.3` publishes as that exact version
}

/**
 * Transform an in-repo (`src`-pointing) package manifest into its PUBLISHED (`dist`-pointing)
 * shape. Pure — clones its input, touches nothing on disk. Applied to a staged copy right before
 * `bun pm pack`, so the tarball ships built artifacts while the in-repo manifest is untouched.
 *
 * What it changes (and ONLY these):
 *  - `exports`: every `./src/<name>.ts[x]` → `./dist/<name>.js` (runtime conditions) / `.d.ts` (`types`).
 *  - `main`/`module`/`types` (only if the manifest already had them — kept coherent with the `.` export).
 *  - `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`: `workspace:` ranges
 *    rewritten to concrete versions (subsuming what `bun pm pack` did in-workspace).
 *  - `files`: set to `["dist"]` (plus `"bin"` when the package ships an executable) so ONLY build
 *    output is published — never `src`.
 *
 * @param {Record<string, any>} manifest the in-repo package.json (as parsed)
 * @param {Record<string, string>} versionMap workspace package name → version (public AND private,
 *        so every `workspace:` edge resolves)
 * @returns {Record<string, any>} a new manifest in published shape
 */
export function rewriteManifestForPublish(manifest, versionMap) {
  const out = structuredClone(manifest);

  if (out.exports !== undefined) out.exports = rewriteExportsToDist(out.exports, false);

  // Keep legacy top-level entry fields coherent with the rewritten `.` export, but ONLY if they
  // were already present (most packages rely on `exports` alone; two content-* carry a stale
  // `main` we normalise rather than leave dangling).
  const dot = out.exports?.["."];
  if (dot && typeof dot === "object") {
    const runtime = dot.default ?? dot.import;
    if (out.main !== undefined && runtime !== undefined) out.main = runtime;
    if (out.module !== undefined && runtime !== undefined) out.module = runtime;
    if (out.types !== undefined && dot.types !== undefined) out.types = dot.types;
  }

  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = out[field];
    if (!deps) continue;
    out[field] = Object.fromEntries(
      Object.entries(deps).map(([name, range]) => [name, rewriteDepRange(name, range, versionMap)]),
    );
  }

  out.files = out.bin ? ["bin", "dist"] : ["dist"];
  return out;
}
