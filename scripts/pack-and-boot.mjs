#!/usr/bin/env node
// Install-and-boot proof (publish-day step 7, RELEASING.md §Verifying).
//
// Lesto ships `.ts` source (exports → `./src/*.ts`) and runs its bins through jiti
// shims (`bin/<name>.mjs`, `#!/usr/bin/env node`), so an outsider who runs
// `npx create-lesto` / `lesto` does so under NODE, never bun. The per-package tests
// and the workspace gate run in-repo against `workspace:*` symlinks — they prove
// nothing about the PACKAGED shape resolving and booting for that outsider. This
// closes that gap the only honest way: pack every public package, scaffold an app
// pinned at the tarballs, then `npm install` + boot it UNDER NODE.
//
// The tarballs are the registry stand-in (`bun pm pack` rewrites each `workspace:*`
// to the exact `0.1.0`, exactly as a real publish would). `npm overrides` force the
// WHOLE `@lesto/*` graph — transitive deps included — onto those tarballs, so nothing
// reaches the as-yet-unpublished registry; only third-party deps (react, jiti,
// better-sqlite3, …) come from npm. Boot is `lesto routes`: it loads the scaffold's
// `lesto.app.ts` and the entire `@lesto/web`/`@lesto/ui` TS+TSX graph through jiti,
// the strongest "the installed package actually runs under node" smoke test that
// needs no database, server, or bun bundler.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const PACKAGES = join(REPO, "packages");

/** Run a command, inheriting stdio, throwing on a non-zero exit. */
function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// 1. Every public package: the de-privatized `0.1.0` closure plus `create-lesto`.
const publicDirs = readdirSync(PACKAGES).filter((name) => {
  const pj = join(PACKAGES, name, "package.json");
  if (!existsSync(pj)) return false;

  const meta = JSON.parse(readFileSync(pj, "utf8"));

  return meta.private !== true && meta.version === "0.1.0";
});

console.log(`[pack-and-boot] packing ${publicDirs.length} public packages…`);

const work = mkdtempSync(join(tmpdir(), "lesto-boot-"));
const vendor = join(work, "vendor");
mkdirSync(vendor);

// 2. Pack each into the vendor dir. `bun pm pack` rewrites `workspace:*` → the exact
//    version in the emitted tarball, so each tarball is self-describing like a publish.
for (const dir of publicDirs) {
  execFileSync("bun", ["pm", "pack", "--destination", vendor], {
    cwd: join(PACKAGES, dir),
    stdio: "pipe",
  });
}

const tarballs = readdirSync(vendor).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== publicDirs.length) {
  throw new Error(`packed ${tarballs.length} tarballs, expected ${publicDirs.length}`);
}

// 3. Map every packaged name → its tarball, read from the tarball's own package.json
//    (robust to scope/filename mangling), to become the install `overrides`.
const overrides = {};
for (const tgz of tarballs) {
  const manifest = execFileSync("tar", ["-xzOf", join(vendor, tgz), "package/package.json"], {
    encoding: "utf8",
  });

  overrides[JSON.parse(manifest).name] = `file:${join(vendor, tgz)}`;
}

// 4. Scaffold through the `create-lesto` bin UNDER NODE (its jiti shim) — half the proof:
//    `npx create-lesto` itself has to run for an outsider.
console.log("[pack-and-boot] scaffolding via create-lesto under node…");
run("node", [join(PACKAGES, "create-lesto", "bin", "create-lesto.mjs"), "boot-proof"], { cwd: work });

const appDir = join(work, "boot-proof");

// 5. Pin the whole `@lesto/*` graph at the tarballs (overrides reach transitive deps too),
//    then `npm install` UNDER NODE — the published-install path, native builds and all.
const appManifestPath = join(appDir, "package.json");
const appManifest = JSON.parse(readFileSync(appManifestPath, "utf8"));

// Point the app's DIRECT `@lesto/*` deps at the tarballs too. npm rejects an
// `overrides` entry that disagrees with a direct dependency's range (EOVERRIDE), so
// the direct dep and its override must name the same tarball. `overrides` then reaches
// the TRANSITIVE `@lesto/*` deps the tarballs declare (e.g. @lesto/queue → @lesto/errors).
for (const dep of Object.keys(appManifest.dependencies ?? {})) {
  if (dep in overrides) appManifest.dependencies[dep] = overrides[dep];
}
appManifest.overrides = overrides;
writeFileSync(appManifestPath, `${JSON.stringify(appManifest, null, 2)}\n`);

console.log("[pack-and-boot] npm install (node) against the tarballs…");
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: appDir });

// 6. Boot the INSTALLED `lesto` bin under node — loads lesto.app.ts + the @lesto graph.
console.log("[pack-and-boot] booting `lesto routes` under node…");
run("node", [join(appDir, "node_modules", ".bin", "lesto"), "routes"], { cwd: appDir });

console.log(
  `\n[pack-and-boot] OK — ${publicDirs.length} packages packed, scaffolded, installed, and booted under node.`,
);
