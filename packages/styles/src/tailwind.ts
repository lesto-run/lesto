/**
 * The real `@tailwindcss/node` + `@tailwindcss/oxide` + `node:fs` wiring behind
 * {@link buildStyles}'s {@link StyleCompiler} seam (ADR 0037, Phase 1 / TW2).
 *
 * This is the Tailwind-engine edge — `compile()` (resolve `@import "tailwindcss"`,
 * apply `@theme`), the oxide `Scanner` (find utility classes by scanning source as
 * plain text), `optimize()` (Lightning CSS minify in production), and the
 * filesystem. It is the `bin`-equivalent of this package: excluded from the
 * coverage gate because it drives an officially-unstable native engine that cannot
 * be branch-covered deterministically, while the orchestration it feeds
 * (`build-styles.ts`) is covered with a fake compiler — exactly as `@lesto/assets`
 * keeps `Bun.build` in `bun.ts` (`packages/assets/src/bun.ts:1-10`). Its real
 * behavior is verified by `test/tailwind.integration.test.ts`, which compiles a
 * real fixture against the installed engine.
 *
 * The engine `@tailwindcss/node`/`@tailwindcss/oxide` are pinned to one exact
 * version (deps of `@lesto/styles`); `tailwindcss` is a `peerDependency` resolved
 * from the app (the single instance the app's `@import "tailwindcss"` pulls, and
 * which shadcn Phase 2 expects resolvable). Everything sits behind the
 * `StyleCompiler` interface so a `@tailwindcss/cli` shell-out could replace this
 * file with no caller change if a 4.x bump breaks the programmatic API.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

import type { CompiledStyles, CompileRequest, StyleCompiler } from "./build-styles";
import { StylesError } from "./errors";

/**
 * The two roots the Tailwind engine needs — distinct on purpose (ADR 0037 P1):
 * `@import "tailwindcss"`/`tw-animate-css` resolve from the *project root* (where
 * `node_modules` lives), but utility classes are scanned from the *app source*.
 * Captured by the factory rather than threaded per-build — they are fixed for a
 * project, the same way `bunBuildClientDeps(appRoot)` captures its root
 * (`packages/assets/src/bun.ts:116`).
 */
export interface TailwindCompilerConfig {
  /** Project root — where `@import "tailwindcss"` resolves from (`node_modules`). */
  readonly resolveBase: string;

  /** App source root — where Tailwind scans class usage (e.g. `<root>/app`). */
  readonly scanRoot: string;
}

/**
 * Compile `request.entry` against `config`'s roots and write the result.
 *
 * Reads the entry, compiles it (resolving `@import`s from `resolveBase` and
 * tracking each as a watch dependency), scans `scanRoot` for utility-class
 * candidates, builds the stylesheet from them, minifies in production, writes it
 * to `outDir/outName`, and reports the written path, the gzipped size, and the
 * full watch set (the scanned source files + the `@import`ed CSS + the entry).
 *
 * A missing entry is the one failure this edge codes itself —
 * `STYLES_ENTRY_NOT_FOUND` — because it owns the filesystem and `buildStyles`
 * propagates coded `StylesError`s unchanged; any other engine throw is left raw
 * for `buildStyles` to wrap as `STYLES_COMPILE_FAILED`.
 */
async function compileStyles(
  config: TailwindCompilerConfig,
  request: CompileRequest,
): Promise<CompiledStyles> {
  let source: string;
  try {
    source = await readFile(request.entry, "utf8");
  } catch {
    throw new StylesError(
      "STYLES_ENTRY_NOT_FOUND",
      `the CSS entry "${request.entry}" does not exist or cannot be read`,
      { entry: request.entry },
    );
  }

  // The watch set: the `@import`ed CSS files (via onDependency), every scanned
  // source file (below), and the entry itself — so any of them changing in dev
  // (TW4) re-runs the build.
  const dependencies = new Set<string>([resolve(request.entry)]);

  const compiler = await compile(source, {
    base: config.resolveBase,
    onDependency: (path) => dependencies.add(path),
  });

  // Tailwind scans the filesystem as plain text (not the JS module graph), so the
  // scan is rooted at the app source explicitly; any `@source` directives the
  // entry declares ride along via the compiler's resolved sources.
  const scanner = new Scanner({
    sources: [{ base: config.scanRoot, pattern: "**/*", negated: false }, ...compiler.sources],
  });
  const candidates = scanner.scan();

  for (const file of scanner.files) dependencies.add(file);

  const built = compiler.build(candidates);
  const { code } = optimize(built, { minify: request.mode === "production" });

  const path = join(request.outDir, request.outName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, code, "utf8");

  return { path, gzipBytes: gzipSync(code).byteLength, dependencies: [...dependencies] };
}

/**
 * The default {@link StyleCompiler}, wired to the real Tailwind v4 engine + the
 * filesystem. The CLI (TW3) constructs it with the project root and `app/` and
 * hands it to {@link buildStyles}:
 *
 *   const result = await buildStyles(
 *     { entry, outDir: "out", mode: "production" },
 *     tailwindStyleCompiler({ resolveBase: projectRoot, scanRoot: join(projectRoot, "app") }),
 *   );
 */
export function tailwindStyleCompiler(config: TailwindCompilerConfig): StyleCompiler {
  return { compile: (request) => compileStyles(config, request) };
}
