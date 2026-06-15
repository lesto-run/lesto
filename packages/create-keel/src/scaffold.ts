/**
 * The scaffolder's one decision: which files to write, with what contents.
 *
 * Injecting the filesystem (`ScaffoldIO`) keeps the decision separate from the
 * timing (touching a disk), so this is tested deterministically against a fake or
 * a real temp dir. `index.ts` is a pure re-export barrel over this module.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CreateKeelError } from "./errors";
import {
  gitignore,
  islandCounter,
  keelApp,
  keelSites,
  packageJson,
  readme,
  tsconfig,
} from "./templates";
import type { KeelDepResolver } from "./templates";

/**
 * The default `@keel/*` dependency pin: a `file:` path to the in-repo package.
 *
 * The packages are not published yet (blocker #9: `@keel/*@latest` could not
 * resolve), so the scaffold pins each to its in-repo directory — computed from
 * this module's location (`packages/create-keel/src` → `packages/<dir>`) — so
 * `bun install` resolves it today against the workspace-linked packages. At the
 * `0.x` publish this single function flips to returning a real `^0.x` range.
 */
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const fileColonPin: KeelDepResolver = (pkg) =>
  `file:${join(PACKAGES_DIR, pkg.replace("@keel/", ""))}`;

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
   * How each `@keel/*` dependency is pinned. Defaults to a `file:` path at the
   * in-repo package (the unpublished-package story — blocker #9). Injected so a
   * test can pin to a fake specifier without depending on the repo layout, and so
   * the `0.x` publish can flip it to a real version range in one place.
   */
  keelDep?: KeelDepResolver;
}

/**
 * Write a minimal but runnable Keel starter into `targetDir`.
 *
 * Refuses to clobber: if the target already exists it throws rather than write
 * over a user's directory. Otherwise it creates the directory and every starter
 * file (including the nested `app/islands/counter.tsx`), and returns the created
 * paths sorted — a stable manifest for callers and tests alike.
 */
export async function scaffold(options: ScaffoldOptions, io: ScaffoldIO): Promise<string[]> {
  const { name, targetDir } = options;
  const keelDep = options.keelDep ?? fileColonPin;

  // Never clobber an existing directory.
  if (await io.exists(targetDir)) {
    throw new CreateKeelError(
      "CREATE_KEEL_TARGET_EXISTS",
      `Cannot scaffold into "${targetDir}": it already exists.`,
      { targetDir },
    );
  }

  await io.mkdir(targetDir);

  // The starter, declared as (relative name -> contents). One source of truth for
  // both what gets written and what manifest comes back. `keel.sites.ts` is what
  // makes `keel build`/`dev` whole (its absence used to crash); the island under
  // `app/islands/` is what `keel build` bundles into `/client.js`.
  const files: ReadonlyArray<readonly [string, string]> = [
    ["package.json", packageJson(name, keelDep)],
    ["keel.app.ts", keelApp()],
    ["keel.sites.ts", keelSites()],
    ["app/islands/counter.tsx", islandCounter()],
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
