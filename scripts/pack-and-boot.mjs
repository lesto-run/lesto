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

// 1. Every public package: the de-privatized closure plus `create-lesto`. Version-agnostic
//    (each package's own version is the source of truth) so a coordinated bump needs no edit
//    here — must match the same filter `scripts/publish.mjs` uses, or the proof and the
//    publish would cover different sets.
const publicDirs = readdirSync(PACKAGES).filter((name) => {
  const pj = join(PACKAGES, name, "package.json");
  if (!existsSync(pj)) return false;

  return JSON.parse(readFileSync(pj, "utf8")).private !== true;
});

console.log(`[pack-and-boot] packing ${publicDirs.length} public packages…`);

const work = mkdtempSync(join(tmpdir(), "lesto-boot-"));
const vendor = join(work, "vendor");
mkdirSync(vendor);

// 2. Pack each into the vendor dir. `bun pm pack` rewrites `workspace:*` → the exact
//    version in the emitted tarball, so each tarball is self-describing like a publish.
for (const dir of publicDirs) {
  try {
    // stdout quiet, but let bun's stderr through so a pack failure names the cause.
    execFileSync("bun", ["pm", "pack", "--destination", vendor], {
      cwd: join(PACKAGES, dir),
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (error) {
    throw new Error(`bun pm pack failed for packages/${dir}`, { cause: error });
  }
}

const tarballs = readdirSync(vendor).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== publicDirs.length) {
  throw new Error(`packed ${tarballs.length} tarballs, expected ${publicDirs.length}`);
}

// 3. Map every packaged name → its tarball (read from the tarball's own package.json,
//    robust to scope/filename mangling) to become the install `overrides`, while
//    recording each packed version + every `@lesto/*` cross-reference for the check below.
const overrides = {};
const packedVersion = {};
const crossRefs = [];
for (const tgz of tarballs) {
  const meta = JSON.parse(
    execFileSync("tar", ["-xzOf", join(vendor, tgz), "package/package.json"], { encoding: "utf8" }),
  );

  overrides[meta.name] = `file:${join(vendor, tgz)}`;
  packedVersion[meta.name] = meta.version;

  // Collect every `@lesto/*` cross-reference, flagging OPTIONAL peers — those may
  // legitimately point at a package outside the published closure (the consumer opts in).
  for (const [dep, range] of Object.entries(meta.dependencies ?? {})) {
    if (dep.startsWith("@lesto/")) crossRefs.push({ from: meta.name, dep, range, optional: false });
  }
  for (const [dep, range] of Object.entries(meta.peerDependencies ?? {})) {
    if (dep.startsWith("@lesto/")) {
      const optional = meta.peerDependenciesMeta?.[dep]?.optional === true;
      crossRefs.push({ from: meta.name, dep, range, optional });
    }
  }
}

// Every NON-OPTIONAL `@lesto/*` cross-reference must name a package we packed, at the exact
// version we packed it: a ref to a package outside the public closure won't be published
// (404 for an outsider), and a stale exact version (e.g. a published `@lesto/cloudflare`
// pinning `@lesto/pg@0.0.0` because bun.lock wasn't regenerated) 404s too. The `overrides`
// below force the whole graph onto local tarballs, MASKING both here — so assert directly.
const bad = crossRefs.filter(
  ({ dep, range, optional }) =>
    !optional &&
    (packedVersion[dep] === undefined ||
      (/^\d+\.\d+\.\d+/.test(range) && range !== packedVersion[dep])),
);
if (bad.length > 0) {
  throw new Error(
    "unpublishable @lesto/* references (regenerate bun.lock, or a target isn't in the public closure):\n" +
      bad
        .map(({ from, dep, range }) => `  ${from} → ${dep}@${range} (packed ${packedVersion[dep] ?? "—"})`)
        .join("\n"),
  );
}

// 4. Scaffold through the `create-lesto` bin UNDER NODE (its jiti shim) — half the proof:
//    `npx create-lesto` itself has to run for an outsider. Pass `--no-install --no-git`:
//    the scaffold's own default `bun install` would pin `@lesto/*` at the published `^0.x`
//    range and 404 against the as-yet-unpublished registry (the very thing this proof
//    stands in for). We want ONLY the file-write + bin-runs-under-node half here; the
//    install proof is step 5's npm install against the packed TARBALLS below.
console.log("[pack-and-boot] scaffolding via create-lesto under node…");
run(
  "node",
  [join(PACKAGES, "create-lesto", "bin", "create-lesto.mjs"), "boot-proof", "--no-install", "--no-git"],
  { cwd: work },
);

const appDir = join(work, "boot-proof");

// 5. Pin the whole `@lesto/*` graph at the tarballs (overrides reach transitive deps too),
//    then `npm install` UNDER NODE — the published-install path, native builds and all.
const appManifestPath = join(appDir, "package.json");
const appManifest = JSON.parse(readFileSync(appManifestPath, "utf8"));

// Point the app's DIRECT `@lesto/*` deps at the tarballs too. npm rejects an
// `overrides` entry that disagrees with a direct dependency's range (EOVERRIDE), so
// the direct dep and its override must name the same tarball. This holds for BOTH
// `dependencies` and `devDependencies` — a scaffold's dev-only `@lesto/island-dev`
// would otherwise disagree with its override and fail EOVERRIDE. `overrides` then
// reaches the TRANSITIVE `@lesto/*` deps the tarballs declare (e.g. @lesto/queue → @lesto/errors).
for (const field of ["dependencies", "devDependencies"]) {
  for (const dep of Object.keys(appManifest[field] ?? {})) {
    if (dep in overrides) appManifest[field][dep] = overrides[dep];
  }
}
appManifest.overrides = overrides;

// Every direct `@lesto/*` dep must now be a tarball `file:` spec. A future scaffold dep on
// a package missing from the public closure would otherwise be left at its `^0.x` range and
// 404 at install — fail HERE with a clear name instead of a buried npm error.
const unpinned = [
  ...Object.entries(appManifest.dependencies ?? {}),
  ...Object.entries(appManifest.devDependencies ?? {}),
]
  .filter(([dep, spec]) => dep.startsWith("@lesto/") && !String(spec).startsWith("file:"))
  .map(([dep]) => dep);
if (unpinned.length > 0) {
  throw new Error(`scaffold @lesto/* deps missing from the packed closure: ${unpinned.join(", ")}`);
}

writeFileSync(appManifestPath, `${JSON.stringify(appManifest, null, 2)}\n`);

console.log("[pack-and-boot] npm install (node) against the tarballs…");
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: appDir });

// 6. Boot the INSTALLED `lesto` bin under node — loads lesto.app.ts + the @lesto graph.
console.log("[pack-and-boot] booting `lesto routes` under node…");
run("node", [join(appDir, "node_modules", ".bin", "lesto"), "routes"], { cwd: appDir });

console.log(
  `\n[pack-and-boot] OK — ${publicDirs.length} packages packed, scaffolded, installed, and booted under node.`,
);
