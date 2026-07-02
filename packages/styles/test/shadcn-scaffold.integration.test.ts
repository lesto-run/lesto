/**
 * End-to-end compile of the REAL `create-lesto` shadcn scaffold stylesheet
 * (ADR 0037 Phase 2 / TW7). The scaffold's unit tests can only assert the STRUCTURE
 * of the emitted `app/styles/app.css` — they never COMPILE it, because `tw-animate-css`
 * is not a dependency of `create-lesto`. So a `tw-animate-css` version/layer drift, or
 * an `@apply` against a token the shadcn `@theme inline` block forgot to expose, would
 * slip past the scaffold suite entirely.
 *
 * This test closes that gap: it feeds the exact scaffold CSS — including the real,
 * un-stubbed `@import "tw-animate-css";` line — through the same `StyleCompiler` seam
 * (`buildStyles` + `tailwindStyleCompiler`) that `lesto build` drives, and asserts the
 * shadcn utilities emit with no compile error.
 *
 * The fixture `fixtures/shadcn-scaffold.app.css` is a FAITHFUL COPY of the output of
 * `stylesApp()` in `packages/create-lesto/src/templates.ts` (it lives in a different
 * package, outside this suite's write boundary, so it is inlined here). If that
 * template changes, regenerate the fixture:
 *
 *   bun -e 'import {stylesApp} from "./packages/create-lesto/src/templates.ts"; \
 *     import {writeFileSync} from "node:fs"; \
 *     writeFileSync("./packages/styles/test/fixtures/shadcn-scaffold.app.css", stylesApp())'
 */

import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildStyles } from "../src/build-styles";
import { tailwindStyleCompiler } from "../src/tailwind";

// `resolveBase` must be a directory from which BOTH `tailwindcss` AND `tw-animate-css`
// resolve; the workspace root (two levels up) hoists them (`tw-animate-css` is a devDep
// of this package — see package.json). This is the same root the shadcn `@import`s use
// in a real scaffolded app whose `node_modules` symlinks back to the workspace.
const resolveBase = join(import.meta.dirname, "..", "..", "..");
const fixture = join(import.meta.dirname, "fixtures", "shadcn-scaffold.app.css");

let projectDir: string;
let appDir: string;
let outDir: string;
let entry: string;

beforeAll(async () => {
  // `realpath` resolves the macOS `/var → /private/var` symlink so paths match the
  // canonical form the oxide scanner reports.
  projectDir = await realpath(await mkdtemp(join(tmpdir(), "lesto-styles-shadcn-it-")));
  appDir = join(projectDir, "app");
  outDir = join(projectDir, "out");
  entry = join(projectDir, "app", "styles", "app.css");

  await mkdir(join(projectDir, "app", "styles"), { recursive: true });

  // The CSS entry IS the scaffold output, byte-for-byte (real `@import "tw-animate-css";`).
  await copyFile(fixture, entry);

  // A scaffold-representative page that exercises the shadcn utilities the theme exposes
  // (`bg-background`/`border-border`/`rounded-lg` — the `@theme inline` color + radius
  // tokens) AND a `tw-animate-css` utility (`animate-in fade-in-0`), so the scan proves
  // BOTH layers emit real classes, not just that the entry parsed. Tailwind scans this as
  // PLAIN TEXT, so the class strings are complete + static.
  await writeFile(
    join(appDir, "page.tsx"),
    `export const Page = () => (
  <main className="bg-background text-foreground border border-border rounded-lg animate-in fade-in-0">
    hi
  </main>
);\n`,
    "utf8",
  );
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("shadcn scaffold app.css (real @tailwindcss/* engine + tw-animate-css)", () => {
  it('compiles the full shadcn v4 theme — incl. @import "tw-animate-css" and the @layer base @apply — with no unknown-token error', async () => {
    // The whole point: this must NOT reject. It compiles the real `@import "tw-animate-css";`
    // (a drift there = a throw) AND the `@layer base { * { @apply border-border outline-ring/50 } }`
    // + `body { @apply bg-background text-foreground }` rules, which resolve `@apply` against the
    // shadcn `@theme inline` tokens at compile time — a missing/renamed token = STYLES_COMPILE_FAILED.
    const result = await buildStyles(
      { entry, outDir, mode: "production" },
      tailwindStyleCompiler({ resolveBase, scanRoot: appDir }),
    );

    expect(result.path).toBe(join(outDir, "styles.css"));
    expect(result.gzipBytes).toBeGreaterThan(0);

    const css = await readFile(result.path, "utf8");

    // The shadcn color utilities — proof the `@theme inline` tokens became real classes.
    expect(css).toContain(".bg-background");
    expect(css).toContain(".text-foreground");
    expect(css).toContain(".border-border");
    // The shadcn radius token (`--radius-lg`) exposed as a utility.
    expect(css).toContain(".rounded-lg");

    // The tokens themselves rode through as `:root` custom properties (light) + `.dark` overrides.
    expect(css).toContain(":root");
    expect(css).toContain("--background:");
    expect(css).toContain("--radius:");
    expect(css).toContain(".dark");

    // tw-animate-css COMPILED FOR REAL: a utility only it defines emits. If a version/layer
    // drift broke the import, either the build above would have thrown or these would be absent.
    expect(css).toContain(".animate-in");
    expect(css).toContain(".fade-in-0");

    // The `@layer base` `@apply` rules resolved — the `body { background: … }` default landed,
    // which only happens if `@apply bg-background` found the token.
    expect(css).toContain("background-color:var(--background)");

    // Production build is minified — no blank lines.
    expect(css).not.toContain("\n\n");

    // The entry rode into the watch set.
    expect(result.dependencies).toContain(entry);
  });
});
