/**
 * create-lesto — the Lesto project scaffolder.
 *
 *   bun create lesto my-app
 *   npm create lesto my-app
 *
 * The public surface is one function, `scaffold`, plus the `ScaffoldIO` seam it
 * writes through and the pure `templates` that supply each file's contents.
 * Injecting the filesystem keeps the decision (which files, with what contents)
 * separate from the timing (touching a disk), so the scaffolder is tested
 * deterministically against a fake or a real temp dir.
 */

export { CreateLestoError, LestoError } from "./errors";
export type { CreateLestoErrorCode } from "./errors";

export { scaffold, fileColonPin, publishedRangePin } from "./scaffold";
export type { ScaffoldIO, ScaffoldOptions } from "./scaffold";

export { create } from "./create";
export type {
  CreateDeps,
  CreateOptions,
  CreateResult,
  Prompter,
  RunResult,
  Runner,
} from "./create";

export {
  agentsMd,
  claudeMd,
  componentsJson,
  envClient,
  gitignore,
  islandCounter,
  lestoApp,
  lestoSites,
  libUtils,
  LESTO_DEV_PACKAGES,
  LESTO_PACKAGES,
  packageJson,
  PREFRESH_DEPS,
  readme,
  routeLayout,
  routePage,
  SHADCN_DEPS,
  skillMd,
  stylesApp,
  toPackageName,
  tsconfig,
  worker,
  wranglerConfig,
} from "./templates";
export type { LestoDepResolver, LestoPackage } from "./templates";
