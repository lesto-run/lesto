/**
 * The full `create-lesto` flow: resolve options (interactive or `--yes`), write
 * the starter (`scaffold`), then bring it to life — `bun install` and `git init` +
 * an initial commit.
 *
 * Like `scaffold`, every side effect is an injected seam so the whole flow is
 * tested deterministically with no prompts, no child processes, and no real disk:
 *
 *   - `ScaffoldIO`  — the filesystem (writing files; shared with `scaffold`).
 *   - `Prompter`    — asking the user a question (one line in / one line out).
 *   - `Runner`      — running a command in the project dir (install / git).
 *
 * `bin.ts` is the thin executable that wires the REAL seams (a `node:readline`
 * prompter, a `node:child_process` `spawn` runner) to this; the timing lives
 * there, the decisions live here.
 */

import { CreateLestoError } from "./errors";
import { fileColonPin, publishedRangePin, scaffold } from "./scaffold";
import type { ScaffoldIO } from "./scaffold";

/** A `package`-name-safe project name: empty, separators, and `..` are refused. */
const VALID_NAME = /^[a-zA-Z0-9._-]+$/;

/** A name that would escape the cwd or surprise the user is refused before any write. */
function assertValidName(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || !VALID_NAME.test(name)) {
    throw new CreateLestoError(
      "CREATE_LESTO_INVALID_NAME",
      `"${name}" is not a valid project name. Use letters, digits, '.', '_' or '-'.`,
      { name },
    );
  }
}

/** Ask the user one question; the answer is returned trimmed (`""` if blank/EOF). */
export type Prompter = (question: string) => Promise<string>;

/** The outcome of running a command — exit code plus captured streams. */
export interface RunResult {
  code: number;

  stdout: string;

  stderr: string;
}

/**
 * Run a command in `cwd`. Resolves with the result even on a non-zero exit (the
 * caller decides whether that is fatal) and rejects only if the command could not
 * be spawned at all — e.g. `git` is not installed.
 */
export type Runner = (command: string, args: readonly string[], cwd: string) => Promise<RunResult>;

/** Everything the flow needs from the outside world — all injected, all fakeable. */
export interface CreateDeps {
  io: ScaffoldIO;

  prompt: Prompter;

  run: Runner;

  /** Where the line-by-line progress goes (defaults to `console.log`). */
  log?: (message: string) => void;
}

/** The raw CLI inputs `bin.ts` parses from `argv`, before defaults are resolved. */
export interface CreateOptions {
  /** The first non-flag argument, if any — the project name. */
  name?: string;

  /** The directory the project goes in (its parent is the cwd). */
  cwd: string;

  /** `--local`: pin `@lesto/*` at in-repo `file:` paths (in-monorepo dev). */
  local: boolean;

  /** `--yes`/`-y`: take every default without prompting (CI / non-interactive). */
  yes: boolean;

  /** `--no-install`: write the files but skip `bun install`. */
  install: boolean;

  /** `--no-git`: write the files but skip `git init` + the initial commit. */
  git: boolean;
}

/** What the flow did — for `bin.ts` to print and for tests to assert on. */
export interface CreateResult {
  name: string;

  targetDir: string;

  files: string[];

  installed: boolean;

  gitInitialized: boolean;
}

/** The default project name when none is given and prompting is off. */
const DEFAULT_NAME = "lesto-app";

/**
 * Resolve the project name: a CLI argument wins; otherwise prompt (unless `--yes`,
 * which takes the default). A blank prompt answer falls back to the default too.
 */
async function resolveName(options: CreateOptions, prompt: Prompter): Promise<string> {
  if (options.name !== undefined) return options.name;

  if (options.yes) return DEFAULT_NAME;

  const answer = await prompt(`Project name: (${DEFAULT_NAME}) `);

  return answer.length > 0 ? answer : DEFAULT_NAME;
}

/**
 * The whole `create-lesto` experience, over injected seams.
 *
 * 1. Resolve + validate the name (a CLI arg, a prompt, or the default).
 * 2. `scaffold` writes the starter (refuses to clobber an existing dir).
 * 3. `bun install` — unless `--no-install`. A non-zero exit is a coded
 *    `CREATE_LESTO_INSTALL_FAILED` (the files are already on disk; the user can
 *    re-run the install), so callers branch on the code.
 * 4. `git init` + an initial commit — unless `--no-git`, and skipped (not failed)
 *    when the target is already inside a git repo or `git` is unavailable. Git is
 *    a nicety, never a reason to fail a scaffold that already wrote + installed.
 */
export async function create(options: CreateOptions, deps: CreateDeps): Promise<CreateResult> {
  const log = deps.log ?? ((message: string) => console.log(message));

  const name = await resolveName(options, deps.prompt);
  assertValidName(name);

  const targetDir = `${options.cwd}/${name}`;

  log(`Creating ${name} in ${targetDir}`);

  const files = await scaffold(
    { name, targetDir, lestoDep: options.local ? fileColonPin : publishedRangePin },
    deps.io,
  );

  log(`Wrote ${files.length} files.`);

  const installed = await maybeInstall(options, deps, targetDir, log);
  const gitInitialized = await maybeGit(options, deps, targetDir, log);

  return { name, targetDir, files, installed, gitInitialized };
}

/** Run `bun install`, unless opted out. Throws a coded error on a non-zero exit. */
async function maybeInstall(
  options: CreateOptions,
  deps: CreateDeps,
  targetDir: string,
  log: (message: string) => void,
): Promise<boolean> {
  if (!options.install) {
    log("Skipping install (--no-install). Run `bun install` when ready.");

    return false;
  }

  log("Installing dependencies (bun install)…");

  const result = await deps.run("bun", ["install"], targetDir);

  if (result.code !== 0) {
    throw new CreateLestoError(
      "CREATE_LESTO_INSTALL_FAILED",
      `\`bun install\` failed (exit ${result.code}). The project is written at ${targetDir}; re-run \`bun install\` there.`,
      { targetDir, code: result.code, stderr: result.stderr },
    );
  }

  log("Dependencies installed.");

  return true;
}

/**
 * Initialize a git repo + an initial commit, unless opted out. Best-effort: a
 * target already inside a repo, an absent `git`, or any non-zero git step is a
 * skip (logged), never a thrown error.
 */
async function maybeGit(
  options: CreateOptions,
  deps: CreateDeps,
  targetDir: string,
  log: (message: string) => void,
): Promise<boolean> {
  if (!options.git) {
    log("Skipping git (--no-git).");

    return false;
  }

  // A target already inside a repo: do not nest a second one — leave the existing
  // history alone. `git rev-parse --is-inside-work-tree` exits 0 there.
  const inside = await deps
    .run("git", ["rev-parse", "--is-inside-work-tree"], targetDir)
    .catch(() => undefined);

  if (inside?.code === 0) {
    log("Skipping git: already inside a git repository.");

    return false;
  }

  const steps: ReadonlyArray<readonly [string, string[]]> = [
    ["git", ["init"]],
    ["git", ["add", "-A"]],
    ["git", ["commit", "-m", "Initial commit from create-lesto"]],
  ];

  for (const [command, args] of steps) {
    const result = await deps.run(command, args, targetDir).catch(() => undefined);

    // A missing `git` (spawn rejected → undefined) or a non-zero step: skip the
    // rest, never fail the scaffold. Git is a nicety, not a gate.
    if (result === undefined || result.code !== 0) {
      log("Skipping git: `git` is unavailable or a git step failed.");

      return false;
    }
  }

  log("Initialized a git repository with an initial commit.");

  return true;
}
