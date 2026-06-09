/**
 * create-keel — the Keel project scaffolder.
 *
 *   bun create keel my-app
 *   npm create keel my-app
 *
 * The public surface is one function, `scaffold`, plus the `ScaffoldIO` seam it
 * writes through and the pure `templates` that supply each file's contents.
 * Injecting the filesystem keeps the decision (which files, with what contents)
 * separate from the timing (touching a disk), so the scaffolder is tested
 * deterministically against a fake or a real temp dir.
 */

export { CreateKeelError, KeelError } from "./errors";
export type { CreateKeelErrorCode } from "./errors";

export { scaffold } from "./scaffold";
export type { ScaffoldIO, ScaffoldOptions } from "./scaffold";

export { gitignore, keelApp, packageJson, readme, tsconfig } from "./templates";
