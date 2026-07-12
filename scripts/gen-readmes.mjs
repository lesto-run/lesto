// Stamp a baseline README onto every PUBLISHED (`private !== true`) `packages/*`
// package that lacks one, so no `@lesto/*` npm page renders "No README data found!"
// at the launch window (plans/006-published-package-readmes.md). npm always includes
// `README.md` in the tarball regardless of the `files` allowlist, so this needs no
// manifest change; the publish pipeline copies it into the staged tarball
// (`scripts/lib/build-public.mjs`), so a README reaches npm at the NEXT release cut.
//
//   node scripts/gen-readmes.mjs             # write the missing READMEs
//   node scripts/gen-readmes.mjs --dry-run   # print what it would write; touch nothing
//   bun run scripts/gen-readmes.mjs --dry-run
//
// SKIP-EXISTING is load-bearing: the generator NEVER overwrites a README that already
// exists, so the 13 hand-written headline batteries — and any package hand-polished with
// a real usage snippet after this runs — are left untouched. Re-running is idempotent:
// the baseline is the floor, hand edits are the ceiling, and the generator only ever
// fills the floor.
//
// The baseline is deliberately snippet-free — an accurate one-line pitch (the manifest
// `description`, which is the single source of truth), the install line, and real docs
// links (verified `/batteries/<slug>` deep links + the agent-readable `llms.txt`). The
// house rule is "do not invent API" (plans/006 §Conventions), so a usage snippet is
// hand-authored into the high-value packages' READMEs against their `src/index.ts`
// exports — never machine-guessed here — which the skip-existing rule then preserves.
//
// Pure render/derive fns are exported for unit tests; the FS-writing `main()` runs only
// when invoked directly (the `import.meta` guard at the bottom), matching new-package.mjs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readPublicPackageDirs } from "./lib/pack-public.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// Package short name → the docs battery slug at https://docs.lesto.run/batteries/<slug>.
// ONLY packages with a real battery page live here (verified against site/content/docs/
// batteries/*.md), so the emitted deep link is never a 404. The slug is NOT always the
// short name — the docs are organized by concept (db→data, ui→components, styles→styling,
// migrate→migrations), so this map is the one place that reconciles the two. A package
// absent from the map links to the docs home instead.
export const DOCS_SLUGS = Object.freeze({
  auth: "auth",
  authz: "authz",
  db: "data",
  env: "env",
  migrate: "migrations",
  observability: "observability",
  openapi: "openapi",
  queue: "queue",
  seo: "seo",
  sites: "sites",
  storage: "storage",
  styles: "styling",
  ui: "components",
});

/** The docs URL for a package: its battery deep link if it has one, else the docs home. */
export function docsUrlFor(shortName) {
  const slug = DOCS_SLUGS[shortName];
  return slug ? `https://docs.lesto.run/batteries/${slug}` : "https://docs.lesto.run";
}

/**
 * The install line for a package. A `create-*` scaffolder is invoked through `bun create`
 * / `npm create` — never `bun add` — so it gets the scaffold command; everything else is a
 * normal dependency install.
 */
export function installCommand(name) {
  const scaffold = /^create-(.+)$/.exec(name);
  return scaffold ? `bun create ${scaffold[1]} my-app` : `bun add ${name}`;
}

/**
 * The baseline README for one package — the house shape (see packages/mail/README.md):
 * `# <name>`, a blockquote pitch, the "Part of Lesto" line, a fenced install command, and
 * the docs links. No usage snippet — that is hand-authored per package against its real
 * exports and preserved by skip-existing.
 */
export function renderReadme({ name, description, shortName }) {
  const docsUrl = docsUrlFor(shortName);

  return `# ${name}

> ${description}

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

\`\`\`bash
${installCommand(name)}
\`\`\`

[Docs](${docsUrl}) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
`;
}

/**
 * The published packages that lack a README today: every public (`private !== true`)
 * `packages/<dir>` with no `README.md`. Reuses the ONE canonical public-set filter
 * (`readPublicPackageDirs`) the publish pipeline uses, so this can never drift from what
 * actually ships. Returns `{ dir, shortName, name, description }` per package, in
 * `readdirSync` order.
 *
 * @param {string} packagesDir absolute path to the repo's `packages/` directory
 */
export function packagesMissingReadme(packagesDir) {
  return readPublicPackageDirs(packagesDir)
    .filter((dir) => !existsSync(join(packagesDir, dir, "README.md")))
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
      return {
        dir,
        shortName: dir,
        name: manifest.name,
        description: manifest.description,
      };
    });
}

/**
 * Write (or, with `dryRun`, describe) a baseline README for every public package missing
 * one. Never touches a package that already has a README. `log` is injectable so the unit
 * test can drive `main` without spraying the console.
 *
 * @returns {{path: string, name: string}[]} the READMEs written (or that would be written)
 */
export function generateReadmes({
  packagesDir = join(REPO, "packages"),
  dryRun = false,
  log = () => {},
} = {}) {
  const missing = packagesMissingReadme(packagesDir);
  const written = [];

  for (const pkg of missing) {
    if (!pkg.description || typeof pkg.description !== "string") {
      // STOP condition (plans/006): a bad/missing description would emit a bad README.
      throw new Error(
        `packages/${pkg.dir} has no usable "description" — fill it in package.json before generating its README.`,
      );
    }

    const path = join(packagesDir, pkg.dir, "README.md");
    const contents = renderReadme(pkg);

    if (dryRun) {
      log(`--- ${path} (${pkg.name}) ---\n${contents}`);
    } else {
      writeFileSync(path, contents);
      log(`  + packages/${pkg.dir}/README.md (${pkg.name})`);
    }

    written.push({ path, name: pkg.name });
  }

  return written;
}

function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const written = generateReadmes({ dryRun, log: (line) => console.log(line) });

  if (written.length === 0) {
    console.log("\nEvery published package already has a README — nothing to generate.");
    return;
  }

  console.log(
    dryRun
      ? `\n[dry-run] would write ${written.length} README(s); touched nothing.`
      : `\nWrote ${written.length} README(s). Hand-polish the high-value packages with a real usage snippet before the release cut.`,
  );
}

// Run only when executed directly (not on import for tests), per scripts/new-package.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
