// Tests for the README generator (scripts/gen-readmes.mjs) AND the REQUIRED launch
// convention it enforces: every published (`private !== true`) `packages/*` MUST ship a
// `README.md`, so no `@lesto/*` npm page renders "No README data found!"
// (plans/006-published-package-readmes.md).
//
// A convention without a check regresses — this repo's traps register logs exactly that
// (a fail-open guard, L-ceb1dc5a). So `packagesMissingReadme(<real packages/>)` is asserted
// EMPTY here, and the assertion is proven NON-VACUOUS by a hermetic case that constructs a
// public package with no README and confirms the check FIRES on it (while a private package
// and an already-documented one are correctly ignored).
//
// NOTE: `scripts/` is OUTSIDE the per-package coverage gate (scripts/coverage-gate.ts sweeps
// only packages/* with a `test:cov`). Like scripts/new-package.test.mjs, this must be listed
// in the scripts-unit vitest invocation in .github/workflows/ci.yml to run in CI. Run directly:
//   bunx vitest run scripts/gen-readmes.test.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  DOCS_SLUGS,
  docsUrlFor,
  generateReadmes,
  installCommand,
  packagesMissingReadme,
  renderReadme,
} from "./gen-readmes.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(REPO, "packages");
const roots = [];

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "gr-test-"));
  roots.push(root);
  return root;
}

/** Write a hermetic package fixture: `<root>/<dir>/package.json` (+ an optional README). */
function writePkg(root, dir, manifest, { readme = false } = {}) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify(manifest));
  if (readme) writeFileSync(join(d, "README.md"), `# ${manifest.name}\n`);
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("installCommand", () => {
  it("is `bun add <name>` for a normal package", () => {
    expect(installCommand("@lesto/queue")).toBe("bun add @lesto/queue");
    expect(installCommand("@lesto/ui")).toBe("bun add @lesto/ui");
  });

  it("is the scaffold command for a `create-*` package (never `bun add`)", () => {
    expect(installCommand("create-lesto")).toBe("bun create lesto my-app");
  });
});

describe("docsUrlFor", () => {
  it("deep-links to the battery page when the package has one", () => {
    expect(docsUrlFor("db")).toBe("https://docs.lesto.run/batteries/data");
    expect(docsUrlFor("ui")).toBe("https://docs.lesto.run/batteries/components");
    expect(docsUrlFor("queue")).toBe("https://docs.lesto.run/batteries/queue");
  });

  it("falls back to the docs home for a package with no battery page", () => {
    expect(docsUrlFor("web")).toBe("https://docs.lesto.run");
    expect(docsUrlFor("cli")).toBe("https://docs.lesto.run");
  });

  it("every slug in the map points at a real docs page (no dead deep links)", () => {
    // Guards DOCS_SLUGS against drift: a mistyped/removed slug would emit a 404 link.
    for (const slug of Object.values(DOCS_SLUGS)) {
      const page = join(REPO, "site", "content", "docs", "batteries", `${slug}.md`);
      expect(existsSync(page), `docs page for slug "${slug}"`).toBe(true);
    }
  });
});

describe("renderReadme", () => {
  it("emits the house README shape (title, pitch, Lesto line, install, docs links)", () => {
    const md = renderReadme({
      name: "@lesto/example",
      description: "An example package.",
      shortName: "example",
    });
    expect(md).toContain("# @lesto/example");
    expect(md).toContain("> An example package.");
    expect(md).toContain("Part of **[Lesto](https://lesto.run)**");
    expect(md).toContain("bun add @lesto/example");
    expect(md).toContain("[Docs](https://docs.lesto.run)");
    expect(md).toContain("[Agent-readable docs](https://docs.lesto.run/llms.txt)");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("uses the battery deep link and the scaffold install line where applicable", () => {
    const db = renderReadme({ name: "@lesto/db", description: "d", shortName: "db" });
    expect(db).toContain("[Docs](https://docs.lesto.run/batteries/data)");

    const create = renderReadme({
      name: "create-lesto",
      description: "d",
      shortName: "create-lesto",
    });
    expect(create).toContain("bun create lesto my-app");
  });
});

describe("packagesMissingReadme — the launch convention check", () => {
  it("REQUIRED: every published package in this repo has a README.md", () => {
    // The forcing function. A new public package with no README turns this RED — which is
    // the intended behavior (plans/006 §Maintenance): add the README, or mark it private.
    expect(packagesMissingReadme(PACKAGES)).toEqual([]);
  });

  it("FIRES on a public package with no README, and ONLY on it (non-vacuous)", () => {
    const root = freshRoot();
    writePkg(root, "gap", { name: "@lesto/gap", description: "no readme yet" }); // flagged
    writePkg(root, "documented", { name: "@lesto/documented", description: "d" }, { readme: true }); // ignored
    writePkg(root, "internal", { name: "@lesto/internal", private: true }); // ignored (private)

    const missing = packagesMissingReadme(root);

    // If the check were vacuous (always []), this equality would fail — that is the point.
    expect(missing.map((p) => p.dir)).toEqual(["gap"]);
    expect(missing[0]).toMatchObject({ name: "@lesto/gap", description: "no readme yet" });
  });
});

describe("generateReadmes", () => {
  it("dry-run reports the missing package but writes nothing", () => {
    const root = freshRoot();
    writePkg(root, "gap", { name: "@lesto/gap", description: "a gap" });

    const written = generateReadmes({ packagesDir: root, dryRun: true });

    expect(written.map((w) => w.name)).toEqual(["@lesto/gap"]);
    expect(existsSync(join(root, "gap", "README.md"))).toBe(false);
  });

  it("writes a baseline README for the missing package, then is a skip-existing no-op", () => {
    const root = freshRoot();
    writePkg(root, "gap", { name: "@lesto/gap", description: "a real gap" });
    writePkg(root, "documented", { name: "@lesto/documented", description: "d" }, { readme: true });

    const first = generateReadmes({ packagesDir: root });
    expect(first.map((w) => w.name)).toEqual(["@lesto/gap"]);

    const readme = readFileSync(join(root, "gap", "README.md"), "utf8");
    expect(readme).toContain("# @lesto/gap");
    expect(readme).toContain("> a real gap");

    // Never clobbers an existing README — second run finds nothing to do.
    expect(generateReadmes({ packagesDir: root })).toEqual([]);

    // And the pre-existing (hand-written) README is untouched.
    expect(readFileSync(join(root, "documented", "README.md"), "utf8")).toBe(
      "# @lesto/documented\n",
    );
  });

  it("throws (STOP condition) if a public package has no usable description", () => {
    const root = freshRoot();
    writePkg(root, "nodesc", { name: "@lesto/nodesc" });
    expect(() => generateReadmes({ packagesDir: root })).toThrow(/no usable "description"/);
  });
});
