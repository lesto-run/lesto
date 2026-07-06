#!/usr/bin/env node
// Publish the public `@lesto/*` surface to npm — CORRECTLY rewriting the
// `workspace:*` protocol, and FAIL-CLOSED so a broken half-release can't ship.
//
// Why this exists instead of `changeset publish`: changesets shells out to
// `npm publish`, and **npm does not understand the `workspace:` protocol** — it
// uploads the literal `"@lesto/foo": "workspace:*"`, which makes every published
// package fail to install with `EUNSUPPORTEDPROTOCOL`. `bun pm pack` DOES rewrite
// `workspace:*` → the exact dependency version in the emitted tarball (the same
// artifact `scripts/pack-and-boot.mjs` proves installs + boots), so we pack with
// bun and hand the resulting tarball to `npm publish`. npm only uploads bytes — it
// never re-reads the workspace spec — so the published shape is the validated one.
//
// AUTH — OIDC trusted publishing, NOT a token. In CI (`.github/workflows/release.yml`)
// there is **no `NPM_TOKEN` and no committed `.npmrc`**: `npm publish` authenticates
// through GitHub's OIDC identity (`id-token: write`), matched against each package's
// "trusted publisher" config on npmjs.com (owner `lesto-run`, repo `lesto`, workflow
// `release.yml`). So EVERY package must have a trusted publisher configured first, or its
// `npm publish` **403s**. A local `bun run release` may still authenticate via a personal
// `npm login`/token, but the CI path — the real release path — is OIDC only.
//
// FAIL-CLOSED ordering: because bun-pack EXACT-pins each `workspace:*` dep (e.g.
// `@lesto/sites@X` pins `@lesto/seo@X`), if `seo` 403s but `sites` already published, every
// install 404s on the transitive dep — a broken release is live. So we publish in
// **dependency-first topological order** and **fail-fast**: the first package whose publish
// fails stops the run immediately, before any dependent (which pins it) can ship. A re-run
// after a fixed cause is idempotent — versions already on the registry are skipped.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Pure logic — exported and unit-tested by `scripts/publish.test.mjs`. These
// functions touch no fs/network/child-process, so importing this module runs
// nothing; the effectful CLI lives in `main()` (guarded at the bottom).
// ---------------------------------------------------------------------------

/**
 * The in-repo `@lesto/*` (workspace) RUNTIME dependency names a manifest declares — from
 * `dependencies` ONLY, deliberately NOT `devDependencies`. The publish-ordering safety
 * invariant is "a dependent (which bun-pack exact-pins its deps) must not ship after a dep
 * failed": that only concerns deps a CONSUMER installs, and npm never installs a published
 * package's devDependencies. So ordering devDeps buys no safety — and it would let a legitimate
 * dev-only edge (package A test-depends on B while B runtime-depends on A) form a false
 * `dependency cycle` that aborts the whole release. A workspace edge is any entry whose NAME is
 * a `@lesto/*` scope OR whose RANGE uses the `workspace:` protocol (catches an unscoped sibling
 * like `create-lesto` if ever depended on locally). Returned names may point outside the
 * publishable set — the topo sort ignores those (see below). (Same reason `peerDependencies` are
 * omitted: every `@lesto` peer in the public set is optional and resolves from the registry.)
 *
 * @param {{dependencies?:Record<string,string>}} manifest
 * @returns {string[]} de-duplicated runtime dependency package names
 */
export function lestoWorkspaceDeps(manifest) {
  const deps = new Set();
  for (const [name, range] of Object.entries(manifest?.dependencies ?? {})) {
    if (name.startsWith("@lesto/") || String(range).startsWith("workspace:")) {
      deps.add(name);
    }
  }
  return [...deps];
}

/**
 * Order the publishable packages so every package's IN-SET workspace dependencies come
 * strictly BEFORE it (a depth-first topological sort). Deps that name a package outside
 * this set — third-party, or a `@lesto/*` not in the published closure — are ignored for
 * ordering: they resolve from the registry, not from this run.
 *
 * Publishing in this order is what makes fail-fast safe: since a dependency is always
 * uploaded before any dependent that pins it, stopping at the first failure guarantees no
 * dependent ever ships against a dependency that failed.
 *
 * @param {{name:string, deps:string[]}[]} packages
 * @returns {string[]} package names, dependency-first
 * @throws {Error} if the graph has a cycle (genuinely unpublishable — a real bug to fix)
 */
export function topoSortPackages(packages) {
  const inSet = new Set(packages.map((p) => p.name));
  const byName = new Map(packages.map((p) => [p.name, p]));
  const state = new Map(); // name -> "visiting" | "done"
  const order = [];

  const visit = (name, stack) => {
    const s = state.get(name);
    if (s === "done") return;
    if (s === "visiting") {
      throw new Error(`dependency cycle in the publishable graph: ${[...stack, name].join(" → ")}`);
    }
    state.set(name, "visiting");
    for (const dep of byName.get(name).deps) {
      // Only in-set deps constrain ordering; a dep outside the set is a registry/third-party
      // package, irrelevant to how we sequence THIS run.
      if (inSet.has(dep)) visit(dep, [...stack, name]);
    }
    state.set(name, "done");
    order.push(name);
  };

  for (const p of packages) visit(p.name, []);
  return order;
}

/**
 * Drive the publish sequence FAIL-CLOSED: attempt each package in the given (dependency-first)
 * order, and STOP the instant one fails — nothing after a failure is attempted. The effectful
 * `publishOne` is injected, so this orchestration unit-tests with a fake and no network.
 *
 * @param {string[]} order package names, dependency-first (from {@link topoSortPackages})
 * @param {(name:string) => ("published"|"skipped")} publishOne uploads one package and returns
 *        whether it was uploaded or skipped (already on the registry); THROWS to signal failure.
 * @returns {{attempted:string[], published:string[], skipped:string[], failed:string|null, error:Error|null}}
 */
export function runPublish(order, publishOne) {
  const attempted = [];
  const published = [];
  const skipped = [];
  for (const name of order) {
    attempted.push(name);
    let result;
    try {
      result = publishOne(name);
    } catch (error) {
      // Fail-closed: return at once so nothing downstream of the failure is attempted.
      return { attempted, published, skipped, failed: name, error };
    }
    (result === "skipped" ? skipped : published).push(name);
  }
  return { attempted, published, skipped, failed: null, error: null };
}

// ---------------------------------------------------------------------------
// Effectful CLI
// ---------------------------------------------------------------------------

/** Is `name@version` already on the registry? (a re-run must not try to overwrite it). */
function alreadyPublished(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === version;
  } catch {
    return false; // E404 — not published yet
  }
}

function main() {
  const REPO = process.cwd();
  const PACKAGES = join(REPO, "packages");

  // Every publishable package: de-privatized, version-agnostic (each package is its own source
  // of truth for its version, so a coordinated bump needs no edit here). This must match the
  // filter `scripts/pack-and-boot.mjs` uses, or the boot-proof and the publish cover different
  // sets.
  //
  // TODO(L-73e2141f): there is no reliable oracle for the release's INTENDED set independent of
  // this same "non-private packages/*" filter, so a package de-privatized between changeset-prep
  // and dispatch (thus lacking a trusted publisher → a 403) can't be caught by a preflight here
  // without a brittle assumption. It IS caught downstream: fail-closed topological ordering (below)
  // stops the run at that 403 before any dependent ships. If an explicit intended-set manifest is
  // introduced, assert `publicDirs` equals it here.
  const publicDirs = readdirSync(PACKAGES).filter((name) => {
    const pj = join(PACKAGES, name, "package.json");
    if (!existsSync(pj)) return false;
    return JSON.parse(readFileSync(pj, "utf8")).private !== true;
  });

  // Source manifests → graph nodes. `topoSortPackages` orders them so every package's workspace
  // deps publish before it.
  const nodes = publicDirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8"));
    return { dir, name: manifest.name, deps: lestoWorkspaceDeps(manifest) };
  });
  const order = topoSortPackages(nodes.map(({ name, deps }) => ({ name, deps })));

  console.log(
    `[publish] packing ${publicDirs.length} public packages with bun (rewrites workspace:*)…`,
  );

  const vendor = join(mkdtempSync(join(tmpdir(), "lesto-publish-")), "vendor");
  mkdirSync(vendor);

  for (const dir of publicDirs) {
    try {
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

  // Map every packaged name → { tarball path, packed version } from the tarball's OWN
  // package.json (robust to scope/filename mangling); the version is the published shape's.
  const tarballByName = new Map();
  for (const tgz of tarballs) {
    const meta = JSON.parse(
      execFileSync("tar", ["-xzOf", join(vendor, tgz), "package/package.json"], { encoding: "utf8" }),
    );
    tarballByName.set(meta.name, { path: join(vendor, tgz), version: meta.version });
  }

  // Every ordered package must have a packed tarball — guards a name mismatch between a source
  // manifest and its emitted artifact.
  const missing = order.filter((name) => !tarballByName.has(name));
  if (missing.length > 0) {
    throw new Error(`no packed tarball for: ${missing.join(", ")}`);
  }

  // Publish dependency-first, FAIL-CLOSED. `runPublish` stops at the first failure, so nothing
  // downstream of a failed dependency is ever uploaded.
  const outcome = runPublish(order, (name) => {
    const { path, version } = tarballByName.get(name);
    const id = `${name}@${version}`;
    if (alreadyPublished(name, version)) {
      console.log(`[publish] skip ${id} (already on registry)`);
      return "skipped";
    }
    // Publish the bun-packed tarball as-is. `--access public` is belt-and-suspenders over the
    // tarball's own `publishConfig.access`. Provenance is set by the workflow env (OIDC) not here.
    execFileSync("npm", ["publish", path, "--access", "public"], { stdio: "inherit" });
    console.log(`[publish] OK ${id}`);
    return "published";
  });

  console.log(
    `\n[publish] ${outcome.published.length} published, ${outcome.skipped.length} skipped` +
      (outcome.failed ? `, FAILED at ${outcome.failed}.` : "."),
  );

  if (outcome.failed) {
    const { version } = tarballByName.get(outcome.failed);
    const notAttempted = order.slice(order.indexOf(outcome.failed) + 1);
    console.error(
      `\n[publish] FAIL-CLOSED — ${outcome.failed}@${version} failed to publish; stopping BEFORE any\n` +
        "dependent (which exact-pins it) can ship against a missing dependency. A 403 here usually\n" +
        "means the package has no trusted-publisher config on npmjs.com yet. Fix the cause and re-run\n" +
        "— already-published packages are skipped idempotently.\n" +
        `[publish] not attempted (downstream): ${notAttempted.join(", ") || "(none)"}`,
    );
    if (outcome.error) console.error(`\n[publish] cause: ${outcome.error.message}`);
    process.exit(1);
  }
}

// Run only when executed directly (`bun run release` / `node scripts/publish.mjs`), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
