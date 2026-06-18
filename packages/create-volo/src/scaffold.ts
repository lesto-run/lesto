/**
 * The scaffolder's one decision: which files to write, with what contents.
 *
 * Injecting the filesystem (`ScaffoldIO`) keeps the decision separate from the
 * timing (touching a disk), so this is tested deterministically against a fake or
 * a real temp dir. `index.ts` is a pure re-export barrel over this module.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CreateVoloError } from "./errors";
import {
  gitignore,
  islandCounter,
  voloApp,
  voloSites,
  packageJson,
  readme,
  tsconfig,
  worker,
  wranglerConfig,
} from "./templates";
import type { VoloDepResolver } from "./templates";

/**
 * The two ways a scaffolded app pins its `@volo/*` dependencies.
 *
 * `publishedRangePin` (the DEFAULT) pins each to a published `^0.x` range — what
 * an outsider gets from `npm create volo-app`, resolvable from the registry once
 * the `0.x` publish lands (see `RELEASING.md`). `fileColonPin` pins each to a
 * `file:` path at the in-repo package — the in-monorepo dev/e2e mode, selected by
 * `create-volo --local`, so `bun install` resolves against the workspace packages
 * before anything is published.
 *
 * The resolver is injectable (`ScaffoldOptions.voloDep`), so a test can pin to a
 * fake specifier and the publish line lives in exactly one place.
 */
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The published range a scaffolded app pins each `@volo/*` dep at by default. */
const VOLO_DEP_RANGE = "^0.1.0";

/** Default pin: the published `^0.x` range (resolves from the registry post-publish). */
export const publishedRangePin: VoloDepResolver = () => VOLO_DEP_RANGE;

/** `--local` pin: a `file:` path at the in-repo package (in-monorepo dev). */
export const fileColonPin: VoloDepResolver = (pkg) =>
  `file:${join(PACKAGES_DIR, pkg.replace("@volo/", ""))}`;

/** The filesystem operations `scaffold` needs — injected so tests can fake them. */
export interface ScaffoldIO {
  mkdir(dir: string): Promise<void>;

  writeFile(path: string, content: string): Promise<void>;

  exists(path: string): Promise<boolean>;
}

/** Where the scaffolded project goes, what to name it, and how to pin its deps. */
export interface ScaffoldOptions {
  name: string;

  targetDir: string;

  /**
   * How each `@volo/*` dependency is pinned. Defaults to `publishedRangePin` (a
   * `^0.x` range an outsider installs from the registry); `create-volo --local`
   * passes `fileColonPin` for in-monorepo dev. Injected so a test can pin to a
   * fake specifier without depending on the repo layout.
   */
  voloDep?: VoloDepResolver;
}

/**
 * Write a minimal but runnable Volo starter into `targetDir`.
 *
 * Refuses to clobber: if the target already exists it throws rather than write
 * over a user's directory. Otherwise it creates the directory and every starter
 * file (including the nested `app/islands/counter.tsx`), and returns the created
 * paths sorted — a stable manifest for callers and tests alike.
 */
export async function scaffold(options: ScaffoldOptions, io: ScaffoldIO): Promise<string[]> {
  const { name, targetDir } = options;
  const voloDep = options.voloDep ?? publishedRangePin;

  // Never clobber an existing directory.
  if (await io.exists(targetDir)) {
    throw new CreateVoloError(
      "CREATE_VOLO_TARGET_EXISTS",
      `Cannot scaffold into "${targetDir}": it already exists.`,
      { targetDir },
    );
  }

  await io.mkdir(targetDir);

  // The starter, declared as (relative name -> contents). One source of truth for
  // both what gets written and what manifest comes back. `volo.sites.ts` is what
  // makes `volo build`/`dev` whole (its absence used to crash); the island under
  // `app/islands/` is what `volo build` bundles into `/client.js`. `worker.ts` +
  // `wrangler.jsonc` are the scaffold→deploy path: `volo deploy --cloudflare`
  // builds `out/` and `wrangler deploy`s the Worker that fronts the app.
  const files: ReadonlyArray<readonly [string, string]> = [
    ["package.json", packageJson(name, voloDep)],
    ["volo.app.ts", voloApp()],
    ["volo.sites.ts", voloSites()],
    ["app/islands/counter.tsx", islandCounter()],
    ["worker.ts", worker()],
    ["wrangler.jsonc", wranglerConfig(name)],
    ["tsconfig.json", tsconfig()],
    [".gitignore", gitignore()],
    ["README.md", readme(name)],
  ];

  const written: string[] = [];

  // A nested relative path (e.g. `app/islands/counter.tsx`) needs its parent
  // directory first; `mkdir` is recursive, so creating the immediate parent is
  // enough and harmless for top-level files (their parent is `targetDir`).
  for (const [relative, content] of files) {
    const path = join(targetDir, relative);

    await io.mkdir(dirname(path));
    await io.writeFile(path, content);

    written.push(path);
  }

  return written.toSorted();
}
