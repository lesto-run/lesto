#!/usr/bin/env node
// Publish the public `@lesto/*` surface to npm — CORRECTLY rewriting the
// `workspace:*` protocol.
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
// Idempotent: a version already on the registry is skipped, so a re-run after a
// partial failure only publishes what's missing. Auth comes from `.npmrc`
// (`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`), same as before.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const PACKAGES = join(REPO, "packages");

// Every publishable package: de-privatized, version-agnostic (each package is its
// own source of truth for its version, so a coordinated bump needs no edit here).
const publicDirs = readdirSync(PACKAGES).filter((name) => {
  const pj = join(PACKAGES, name, "package.json");
  if (!existsSync(pj)) return false;
  return JSON.parse(readFileSync(pj, "utf8")).private !== true;
});

console.log(`[publish] packing ${publicDirs.length} public packages with bun (rewrites workspace:*)…`);

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

const published = [];
const skipped = [];
const failed = [];

for (const tgz of tarballs) {
  const meta = JSON.parse(
    execFileSync("tar", ["-xzOf", join(vendor, tgz), "package/package.json"], { encoding: "utf8" }),
  );
  const id = `${meta.name}@${meta.version}`;

  if (alreadyPublished(meta.name, meta.version)) {
    console.log(`[publish] skip ${id} (already on registry)`);
    skipped.push(id);
    continue;
  }

  try {
    // Publish the bun-packed tarball as-is. `--access public` is belt-and-suspenders
    // over the tarball's own `publishConfig.access`. Provenance is intentionally NOT
    // set here (it requires CI OIDC; a local publish without it just omits the badge).
    execFileSync("npm", ["publish", join(vendor, tgz), "--access", "public"], { stdio: "inherit" });
    console.log(`[publish] OK ${id}`);
    published.push(id);
  } catch (error) {
    console.error(`[publish] FAILED ${id}: ${error.message}`);
    failed.push(id);
  }
}

console.log(
  `\n[publish] done — ${published.length} published, ${skipped.length} skipped, ${failed.length} failed.`,
);
if (failed.length > 0) {
  console.error("[publish] failures:\n" + failed.map((f) => `  ${f}`).join("\n"));
  process.exit(1);
}
