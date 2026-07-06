/**
 * The scaffolder's one decision: which files to write, with what contents.
 *
 * Injecting the filesystem (`ScaffoldIO`) keeps the decision separate from the
 * timing (touching a disk), so this is tested deterministically against a fake or
 * a real temp dir. `index.ts` is a pure re-export barrel over this module.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CreateLestoError } from "./errors";
import {
  agentsMd,
  claudeMd,
  skillMd,
  componentsJson,
  env,
  envClient,
  gitignore,
  islandCounter,
  lestoApp,
  lestoSites,
  libUtils,
  packageJson,
  readme,
  routeLayout,
  routePage,
  stylesApp,
  tsconfig,
  worker,
  wranglerConfig,
} from "./templates";
import type { LestoDepResolver } from "./templates";

/**
 * The two ways a scaffolded app pins its `@lesto/*` dependencies.
 *
 * `publishedRangePin` (the DEFAULT) pins each to a published `^0.x` range — what
 * an outsider gets from `npm create lesto`. Lesto `0.1.x` is published, so this
 * resolves straight from the registry (see `RELEASING.md`). `fileColonPin` pins
 * each to a `file:` path at the in-repo package — the in-monorepo dev/e2e mode,
 * selected by `create-lesto --local`, so `bun install` resolves against the
 * workspace packages without touching the registry.
 *
 * The resolver is injectable (`ScaffoldOptions.lestoDep`), so a test can pin to a
 * fake specifier and the publish line lives in exactly one place.
 */
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The published range a scaffolded app pins each `@lesto/*` dep at by default. */
const LESTO_DEP_RANGE = "^0.1.0";

/** Default pin: the published `^0.x` range (resolves from the registry post-publish). */
export const publishedRangePin: LestoDepResolver = () => LESTO_DEP_RANGE;

/** `--local` pin: a `file:` path at the in-repo package (in-monorepo dev). */
export const fileColonPin: LestoDepResolver = (pkg) =>
  `file:${join(PACKAGES_DIR, pkg.replace("@lesto/", ""))}`;

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
   * How each `@lesto/*` dependency is pinned. Defaults to `publishedRangePin` (a
   * `^0.x` range an outsider installs from the registry); `create-lesto --local`
   * passes `fileColonPin` for in-monorepo dev. Injected so a test can pin to a
   * fake specifier without depending on the repo layout.
   */
  lestoDep?: LestoDepResolver;
}

/**
 * Write a minimal but runnable Lesto starter into `targetDir`.
 *
 * Refuses to clobber: if the target already exists it throws rather than write
 * over a user's directory. Otherwise it creates the directory and every starter
 * file (including the nested `app/islands/counter.tsx`), and returns the created
 * paths sorted — a stable manifest for callers and tests alike.
 */
export async function scaffold(options: ScaffoldOptions, io: ScaffoldIO): Promise<string[]> {
  const { name, targetDir } = options;
  const lestoDep = options.lestoDep ?? publishedRangePin;

  // Never clobber an existing directory.
  if (await io.exists(targetDir)) {
    throw new CreateLestoError(
      "CREATE_LESTO_TARGET_EXISTS",
      `Cannot scaffold into "${targetDir}": it already exists.`,
      { targetDir },
    );
  }

  await io.mkdir(targetDir);

  // The starter, declared as (relative name -> contents). One source of truth for
  // both what gets written and what manifest comes back. `env.ts` is the typed,
  // validated environment (`@lesto/env`) `lesto.app.ts` reads its DB path from;
  // `env.client.ts` holds its `PUBLIC_*` schema, shared with the island and inlined
  // into the client bundle by `lesto build`/`dev`. `lesto.sites.ts` is what
  // makes `lesto build`/`dev` whole (its absence used to crash); the island under
  // `app/islands/` is what `lesto build` bundles into `/client.js`. The home page
  // lives at `app/routes/page.tsx` (file-based routing, ADR 0023) wrapped by
  // `app/routes/layout.tsx`, so the headline "drop a file → it routes" convention
  // is visible on day one. `worker.ts` + `wrangler.jsonc` are the scaffold→deploy
  // path: `lesto deploy --cloudflare` builds `out/` and `wrangler deploy`s the
  // Worker that fronts the app. `AGENTS.md`/`CLAUDE.md` onboard a coding agent,
  // and `.claude/skills/lesto/SKILL.md` is the first-party Claude Code skill
  // (auto-discovered under `.claude/skills/`) teaching the dev→MCP loop.
  // `components.json` + `app/lib/utils.ts` (`cn()`) make the app a generic shadcn
  // project (ADR 0037 Phase 2): `lesto add <name>` installs components into
  // `app/components/ui` via the `@/*` tsconfig path `components.json` resolves against.
  const files: ReadonlyArray<readonly [string, string]> = [
    ["package.json", packageJson(name, lestoDep)],
    ["env.ts", env()],
    ["env.client.ts", envClient()],
    ["lesto.app.ts", lestoApp()],
    ["lesto.sites.ts", lestoSites()],
    ["app/routes/page.tsx", routePage()],
    ["app/routes/layout.tsx", routeLayout()],
    ["app/islands/counter.tsx", islandCounter()],
    ["app/styles/app.css", stylesApp()],
    ["app/lib/utils.ts", libUtils()],
    ["components.json", componentsJson()],
    ["worker.ts", worker()],
    ["wrangler.jsonc", wranglerConfig(name)],
    ["tsconfig.json", tsconfig()],
    [".gitignore", gitignore()],
    ["AGENTS.md", agentsMd(name)],
    ["CLAUDE.md", claudeMd(name)],
    [".claude/skills/lesto/SKILL.md", skillMd()],
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
