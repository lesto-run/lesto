/**
 * The real-engine edge — `tailwind.ts` — verified end-to-end against the installed
 * `@tailwindcss/*` train. This is the coverage-excluded `bin`-equivalent (it drives
 * the native engine + the filesystem), so it is proven by compiling a real fixture
 * rather than by branch coverage — exactly as `@lesto/assets`'s `bun.ts` is proven
 * by the `bundle-size` script, not vitest.
 *
 * The fixture is a project root holding `node_modules` (the workspace's, via
 * `resolveBase`) so `@import "tailwindcss"` resolves, plus a tiny `app/` whose TSX
 * uses a stock utility and a custom-`@theme` one.
 */

import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildStyles } from "../src/build-styles";
import { StylesError } from "../src/errors";
import { tailwindStyleCompiler } from "../src/tailwind";

// `resolveBase` must be a directory from which `tailwindcss` resolves; the
// workspace root (two levels up from this package) hoists it.
const resolveBase = join(import.meta.dirname, "..", "..", "..");

let projectDir: string;
let appDir: string;
let outDir: string;
let entry: string;

beforeAll(async () => {
  // `realpath` resolves the macOS `/var → /private/var` symlink so paths match the
  // canonical form the oxide scanner reports (it canonicalizes the files it scans).
  projectDir = await realpath(await mkdtemp(join(tmpdir(), "lesto-styles-it-")));
  appDir = join(projectDir, "app");
  outDir = join(projectDir, "out");
  entry = join(projectDir, "app", "styles", "app.css");

  await mkdir(join(projectDir, "app", "styles"), { recursive: true });
  await writeFile(
    join(appDir, "page.tsx"),
    `export const Page = () => <main className="text-center font-display p-4">hi</main>;\n`,
    "utf8",
  );
  await writeFile(
    entry,
    `@import "tailwindcss";\n@theme {\n  --font-display: "Satoshi", sans-serif;\n}\n`,
    "utf8",
  );
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("tailwindStyleCompiler (real @tailwindcss/* engine)", () => {
  it("compiles the entry, scans the app, and writes a minified stylesheet with the used utilities + theme vars", async () => {
    const result = await buildStyles(
      { entry, outDir, mode: "production" },
      tailwindStyleCompiler({ resolveBase, scanRoot: appDir }),
    );

    expect(result.path).toBe(join(outDir, "styles.css"));
    expect(result.gzipBytes).toBeGreaterThan(0);

    const css = await readFile(result.path, "utf8");
    // The stock utility scanned from `app/page.tsx`.
    expect(css).toContain("text-center");
    // The custom `@theme` token is emitted as a `:root` custom property.
    expect(css).toContain(":root");
    expect(css).toContain("--font-display");
    // Minified in production — no double newlines.
    expect(css).not.toContain("\n\n");

    // The watch set names the @import'ed CSS, the scanned source, and the entry.
    expect(result.dependencies.length).toBeGreaterThan(0);
    expect(result.dependencies).toContain(join(appDir, "page.tsx"));
    expect(result.dependencies).toContain(entry);
  });

  it("throws STYLES_ENTRY_NOT_FOUND when the CSS entry does not exist", async () => {
    const error = await buildStyles(
      { entry: join(projectDir, "app", "styles", "missing.css"), outDir, mode: "development" },
      tailwindStyleCompiler({ resolveBase, scanRoot: appDir }),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(StylesError);
    expect((error as StylesError).code).toBe("STYLES_ENTRY_NOT_FOUND");
  });
});
