/**
 * The scaffolder's one decision: which files to write, with what contents.
 *
 * Injecting the filesystem (`ScaffoldIO`) keeps the decision separate from the
 * timing (touching a disk), so this is tested deterministically against a fake or
 * a real temp dir. `index.ts` is a pure re-export barrel over this module.
 */

import { join } from "node:path";

import { CreateKeelError } from "./errors";
import { gitignore, keelApp, packageJson, readme, tsconfig } from "./templates";

/** The filesystem operations `scaffold` needs — injected so tests can fake them. */
export interface ScaffoldIO {
  mkdir(dir: string): Promise<void>;

  writeFile(path: string, content: string): Promise<void>;

  exists(path: string): Promise<boolean>;
}

/** Where the scaffolded project goes, and what to name it. */
export interface ScaffoldOptions {
  name: string;

  targetDir: string;
}

/**
 * Write a minimal but runnable Keel starter into `targetDir`.
 *
 * Refuses to clobber: if the target already exists it throws rather than write
 * over a user's directory. Otherwise it creates the directory and every starter
 * file, and returns the created paths sorted — a stable manifest for callers and
 * tests alike.
 */
export async function scaffold(options: ScaffoldOptions, io: ScaffoldIO): Promise<string[]> {
  const { name, targetDir } = options;

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
  // both what gets written and what manifest comes back.
  const files: ReadonlyArray<readonly [string, string]> = [
    ["package.json", packageJson(name)],
    ["keel.app.ts", keelApp()],
    ["tsconfig.json", tsconfig()],
    [".gitignore", gitignore()],
    ["README.md", readme(name)],
  ];

  const written: string[] = [];

  for (const [relative, content] of files) {
    const path = join(targetDir, relative);

    await io.writeFile(path, content);

    written.push(path);
  }

  return written.toSorted();
}
