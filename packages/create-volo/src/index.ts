/**
 * create-volo — the Volo project scaffolder.
 *
 *   bun create volo my-app
 *   npm create volo my-app
 *
 * The public surface is one function, `scaffold`, plus the `ScaffoldIO` seam it
 * writes through and the pure `templates` that supply each file's contents.
 * Injecting the filesystem keeps the decision (which files, with what contents)
 * separate from the timing (touching a disk), so the scaffolder is tested
 * deterministically against a fake or a real temp dir.
 */

export { CreateVoloError, VoloError } from "./errors";
export type { CreateVoloErrorCode } from "./errors";

export { scaffold, fileColonPin, publishedRangePin } from "./scaffold";
export type { ScaffoldIO, ScaffoldOptions } from "./scaffold";

export {
  gitignore,
  islandCounter,
  voloApp,
  voloSites,
  VOLO_PACKAGES,
  packageJson,
  readme,
  tsconfig,
  worker,
  wranglerConfig,
} from "./templates";
export type { VoloDepResolver } from "./templates";
