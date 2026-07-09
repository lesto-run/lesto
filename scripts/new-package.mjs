// Scaffold a new public `@lesto/*` package with the exact publishable shape the
// release pipeline expects — so the de-privatization metadata (the easy-to-get-wrong
// part: `files:["src"]`, source-published `exports`, `publishConfig.access`,
// `repository.directory`, the current fixed-group version) is generated, never
// hand-rolled. See RELEASING.md "Adding a new package".
//
//   node scripts/new-package.mjs <shortname> ["one-line description"]
//   bun run new-package <shortname> ["one-line description"]
//
// It writes packages/<shortname>/{package.json,tsconfig.json,vitest.config.ts,
// README.md,src/index.ts,src/<shortname>.ts,test/<shortname>.test.ts} — a package
// that already passes typecheck + `vitest run` at 100% coverage (a placeholder
// module + its test; index.ts is coverage-excluded per the house config). Replace
// the placeholder with the real implementation.
//
// Pure render/derive fns are exported for unit tests; the FS-writing `main()` runs
// only when invoked directly (the `import.meta` guard at the bottom), matching
// scripts/publish.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readPublicPackageDirs } from "./lib/pack-public.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// The reference package whose static config we copy verbatim (CONTRIBUTING.md: "match
// packages/queue"). Copying — rather than re-encoding — keeps the generated tsconfig /
// vitest.config drift-free as the house shape evolves.
const REFERENCE = "queue";

// JS reserved words a short name could collide with — the export-name model can't
// represent them (\`export function new()\` is a syntax error), so reject up front.
const RESERVED = new Set([
  "await",
  "async",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** `foo` → `@lesto/foo`. */
export function packageName(shortName) {
  return `@lesto/${shortName}`;
}

/**
 * A short name is a valid npm scope segment: lowercase, digits, single hyphens — and
 * must START WITH A LETTER, so the derived export identifier is legal JS (a leading
 * digit would emit \`export function 3d()\`, a hard syntax error that reds the repo gate).
 */
export function isValidShortName(shortName) {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(shortName);
}

/** `mailing-lists` → `mailingLists`, `i18n` → `i18n` — a JS identifier for the stub export. */
export function toIdentifier(shortName) {
  const [head, ...rest] = shortName.split("-");
  return head + rest.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

/** Parse `x.y.z` to numeric segments; a non-numeric/prerelease segment (`0-canary`) → 0. */
function parseVersion(v) {
  return v.split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/** Compare two `x.y.z` versions; returns >0 if a is newer. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * The current fixed-group line: the max version across the published (`private !== true`)
 * packages. A new package is born AT this line (not `0.0.0`) so it is lockstep-consistent
 * immediately and never trips the `assertVersionsBumped` placeholder guard.
 */
export function currentLineVersion(packagesDir) {
  let max = "0.1.0";
  // Reuse the ONE canonical public-set filter (shared with publish.mjs + pack-and-boot.mjs)
  // rather than re-implementing `private !== true` a third time.
  for (const dir of readPublicPackageDirs(packagesDir)) {
    const manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    if (typeof manifest.version === "string" && compareVersions(manifest.version, max) > 0) {
      max = manifest.version;
    }
  }
  return max;
}

/** The publishable package.json — the shape every `@lesto/*` package must have. */
export function renderPackageJson({ shortName, description, version }) {
  return `${JSON.stringify(
    {
      name: packageName(shortName),
      version,
      license: "MIT",
      description,
      type: "module",
      exports: {
        ".": {
          types: "./src/index.ts",
          import: "./src/index.ts",
        },
      },
      scripts: {
        test: "vitest run",
        "test:cov": "vitest run --coverage",
        typecheck: "tsc --noEmit",
        lint: "oxlint src test",
        format: "oxfmt src test",
        "format:check": "oxfmt --check src test",
      },
      publishConfig: {
        access: "public",
      },
      files: ["src"],
      repository: {
        type: "git",
        url: "git+https://github.com/lesto-run/lesto.git",
        directory: `packages/${shortName}`,
      },
      homepage: "https://lesto.run",
      bugs: {
        url: "https://github.com/lesto-run/lesto/issues",
      },
    },
    null,
    2,
  )}\n`;
}

/** Copy the reference package's tsconfig verbatim (it holds no package-specific names). */
export function renderTsconfig() {
  return readFileSync(join(REPO, "packages", REFERENCE, "tsconfig.json"), "utf8");
}

/** Copy the reference package's vitest config verbatim (uniform across the surface). */
export function renderVitestConfig() {
  return readFileSync(join(REPO, "packages", REFERENCE, "vitest.config.ts"), "utf8");
}

export function renderIndex({ shortName, description, identifier }) {
  return `/**
 * ${packageName(shortName)} — ${description}
 *
 * TODO: replace the placeholder below with the real public API, and document it
 * with a short usage snippet (see any sibling package's index.ts for the house style).
 */

export { ${identifier} } from "./${shortName}";
`;
}

export function renderStub({ shortName, identifier }) {
  return `/**
 * Placeholder so a freshly-scaffolded ${packageName(shortName)} typechecks and passes
 * its coverage gate. Delete this and build the real thing.
 */
export function ${identifier}(): string {
  return ${JSON.stringify(packageName(shortName))};
}
`;
}

export function renderTest({ shortName, identifier }) {
  return `import { describe, expect, it } from "vitest";

import { ${identifier} } from "../src/${shortName}";

describe(${JSON.stringify(packageName(shortName))}, () => {
  it("is a placeholder until the real implementation lands", () => {
    expect(${identifier}()).toBe(${JSON.stringify(packageName(shortName))});
  });
});
`;
}

export function renderReadme({ shortName, description }) {
  const name = packageName(shortName);
  return `# ${name}

> ${description}

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

\`\`\`bash
bun add ${name}
\`\`\`

TODO: a one-paragraph pitch + a minimal usage snippet before this package publishes
(a bare npm page under launch scrutiny is an unforced own-goal — see RELEASING.md).

[Docs](https://docs.lesto.run)
`;
}

/** Write the package tree. Returns the created file paths. `root` is overridable for tests. */
export function createPackage({ shortName, description, root = join(REPO, "packages") }) {
  if (!isValidShortName(shortName)) {
    throw new Error(
      `invalid package short name "${shortName}": must start with a lowercase letter, then lowercase letters, digits, and single hyphens (e.g. "mailing-lists").`,
    );
  }
  const identifier = toIdentifier(shortName);
  if (RESERVED.has(identifier)) {
    throw new Error(
      `"${shortName}" derives the reserved JS identifier "${identifier}" — pick another name, or a hyphenated one (e.g. "${shortName}-core").`,
    );
  }
  const pkgDir = join(root, shortName);
  if (existsSync(pkgDir)) {
    throw new Error(`packages/${shortName} already exists — refusing to overwrite.`);
  }

  const version = currentLineVersion(join(REPO, "packages"));
  const desc = description ?? `${packageName(shortName)} — TODO: describe this package.`;

  const files = {
    "package.json": renderPackageJson({ shortName, description: desc, version }),
    "tsconfig.json": renderTsconfig(),
    "vitest.config.ts": renderVitestConfig(),
    "README.md": renderReadme({ shortName, description: desc }),
    [join("src", "index.ts")]: renderIndex({ shortName, description: desc, identifier }),
    [join("src", `${shortName}.ts`)]: renderStub({ shortName, identifier }),
    [join("test", `${shortName}.test.ts`)]: renderTest({ shortName, identifier }),
  };

  mkdirSync(join(pkgDir, "src"), { recursive: true });
  mkdirSync(join(pkgDir, "test"), { recursive: true });
  const written = [];
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(pkgDir, rel);
    writeFileSync(abs, contents);
    written.push(abs);
  }
  return { pkgDir, version, written };
}

function main() {
  const [shortName, description] = process.argv.slice(2);
  if (!shortName) {
    console.error('usage: node scripts/new-package.mjs <shortname> ["one-line description"]');
    process.exit(1);
  }

  const { pkgDir, version, written } = createPackage({ shortName, description });

  console.log(`\nCreated ${packageName(shortName)}@${version} at ${pkgDir}`);
  for (const f of written) console.log(`  + ${f.slice(REPO.length + 1)}`);
  console.log(`
Next steps:
  1. bun install                          # link the workspace + refresh bun.lock
  2. cd packages/${shortName} && bun run test && bun run typecheck   # green out of the box
  3. Build the real thing (replace src/${shortName}.ts + the stub test), keep 100% coverage.
  4. bun changeset                         # record the bump (fixed group → moves with the line)

To PUBLISH it (it is a brand-new name on npm): follow RELEASING.md "How to cut a
release" — a new name needs a ONE-TIME manual first-publish bootstrap + a trusted-publisher
config; it CANNOT go out via the normal OIDC dispatch until it exists on the registry.
`);
}

// Run only when executed directly (not on import for tests), per scripts/publish.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
