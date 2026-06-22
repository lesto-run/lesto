/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs, tests,
 * and the CLI's exit path branch on the code — never on a message string, which
 * is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

/**
 * Everything the scaffolder can refuse to do, as a stable code union.
 *
 *   - `CREATE_LESTO_TARGET_EXISTS`  — the target dir already exists; we never clobber.
 *   - `CREATE_LESTO_INVALID_NAME`   — the chosen project name is empty or unsafe as a
 *     directory name (path separators, `..`, leading dots), so we refuse before any
 *     write rather than scaffold into a surprising location.
 *   - `CREATE_LESTO_INSTALL_FAILED` — the post-scaffold dependency install exited
 *     non-zero. The files are already written; the caller can re-run the install by
 *     hand, so this is reported (with the runner's exit code) rather than swallowed.
 *
 * Git failures are deliberately NOT in this union: `git init` + the initial commit
 * are best-effort niceties (skipped when the target is already inside a repo, and
 * tolerated when `git` is absent), never a reason to fail a scaffold that already
 * wrote its files and installed its deps.
 */
export type CreateLestoErrorCode =
  | "CREATE_LESTO_TARGET_EXISTS"
  | "CREATE_LESTO_INVALID_NAME"
  | "CREATE_LESTO_INSTALL_FAILED";

/** Anything the scaffolder can refuse to do. */
export class CreateLestoError extends LestoError<CreateLestoErrorCode> {
  constructor(code: CreateLestoErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CreateLestoError";
  }
}
