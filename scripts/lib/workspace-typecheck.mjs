// The workspace typecheck behind `bun run ws:typecheck`, at a capped concurrency.
//
// `bun run --filter '@lesto/*' typecheck` started every package's `tsc --noEmit` at once — about
// 90 of them — and the hosted CI runner ran out of CPU and memory: the `check` job died in its
// Typecheck step with "The runner has received a shutdown signal" or "The hosted runner lost
// communication with the server", with no type error anywhere. Running at most
// `TYPECHECK_CONCURRENCY` at a time keeps the runner alive. Order does not matter: every
// `typecheck` is `tsc --noEmit` over source (`exports` point at `src/*.ts`), so no package needs
// another one built first.
//
// Every export except `readWorkspacePackages` and `spawnTypecheck` is PURE and unit-tested in
// `scripts/workspace-typecheck.test.mjs` (registered in `test:scripts-unit`). `scripts/` is outside
// the oxlint/typecheck/coverage gates, so that test is the real guard here.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How many `tsc` processes run at once. 4 fits the 4-vCPU hosted runner. */
export const TYPECHECK_CONCURRENCY = 4;

/** The package-name scope `ws:typecheck` covers, the same one the old `--filter` matched. */
export const PACKAGE_SCOPE = "@lesto/";

/** The script each package runs. */
export const TYPECHECK_SCRIPT = "typecheck";

const WILDCARD_SUFFIX = "/*";
const NEGATION_PREFIX = "!";

/**
 * Expand the root `workspaces` globs into package directories (relative to the root). Supports the
 * shapes this repo uses: a literal path, a `dir/*` one-level wildcard, and a `!path` exclusion.
 * Any other glob shape throws, so a new pattern cannot silently drop packages from the typecheck.
 *
 * @param {readonly string[]} patterns the root `package.json` `workspaces` array
 * @param {(dir: string) => readonly string[]} listDirs the sub-directory names of a directory
 * @returns {string[]} the package directories, sorted
 */
export function expandWorkspaces(patterns, listDirs) {
  const included = new Set();
  const excluded = new Set();

  for (const pattern of patterns) {
    const isExclusion = pattern.startsWith(NEGATION_PREFIX);
    const path = isExclusion ? pattern.slice(NEGATION_PREFIX.length) : pattern;
    const target = isExclusion ? excluded : included;

    if (path.endsWith(WILDCARD_SUFFIX)) {
      const parent = path.slice(0, -WILDCARD_SUFFIX.length);

      assertLiteral(parent, pattern);

      for (const name of listDirs(parent)) target.add(`${parent}/${name}`);
    } else {
      assertLiteral(path, pattern);

      target.add(path);
    }
  }

  return [...included].filter((dir) => !excluded.has(dir)).toSorted();
}

function assertLiteral(path, pattern) {
  if (/[*?[\]{}]/.test(path)) {
    throw new Error(`workspace-typecheck: unsupported workspaces pattern "${pattern}"`);
  }
}

/**
 * Keep the packages `ws:typecheck` runs: in the `@lesto/` scope and declaring a `typecheck` script.
 *
 * @param {readonly { dir: string, manifest: { name?: string, scripts?: Record<string, string> } }[]} packages
 * @returns {{ name: string, dir: string }[]} sorted by name
 */
export function selectTypecheckPackages(packages) {
  return packages
    .filter(({ manifest }) => manifest.name?.startsWith(PACKAGE_SCOPE) === true)
    .filter(({ manifest }) => manifest.scripts?.[TYPECHECK_SCRIPT] !== undefined)
    .map(({ dir, manifest }) => ({ name: /** @type {string} */ (manifest.name), dir }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Run `task` over every item with at most `limit` in flight, starting the next one as soon as one
 * settles. Results keep the input order.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit at least 1
 * @param {(item: T) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function runLimited(items, limit, task) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`workspace-typecheck: concurrency must be a positive integer, got ${limit}`);
  }

  const results = Array.from({ length: items.length });
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

/**
 * The closing summary: `null` when every package passed, else one line per failed package with its
 * exit code (or the reason it could not start).
 *
 * @param {readonly { name: string, code: number | null, error?: string }[]} results
 * @returns {string | null}
 */
export function summarizeFailures(results) {
  const failed = results.filter(({ code }) => code !== 0);

  if (failed.length === 0) return null;

  const lines = failed.map(({ name, code, error }) =>
    error === undefined ? `  ${name}: exit ${code}` : `  ${name}: could not start (${error})`,
  );

  return [`ws:typecheck failed in ${failed.length} of ${results.length} packages:`, ...lines].join(
    "\n",
  );
}

/**
 * Read the workspace packages under `root` (fs-touching).
 *
 * @param {string} root the repository root
 * @returns {{ dir: string, manifest: { name?: string, scripts?: Record<string, string> } }[]}
 */
export function readWorkspacePackages(root) {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const listDirs = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

  return expandWorkspaces(rootManifest.workspaces ?? [], listDirs).flatMap((dir) => {
    try {
      return [{ dir, manifest: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) }];
    } catch {
      return [];
    }
  });
}

/**
 * Run one package's `typecheck` script, buffering its output so parallel runs never interleave.
 *
 * @param {string} cwd the package directory
 * @returns {Promise<{ code: number | null, output: string, error?: string }>}
 */
export function spawnTypecheck(cwd) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", "--silent", TYPECHECK_SCRIPT], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));

    child.on("error", (error) => resolve({ code: null, output: "", error: error.message }));
    child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8") }));
  });
}
