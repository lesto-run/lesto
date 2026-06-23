/**
 * Walk a convention directory into the flat {@link DiscoveredFile} list the
 * compiler takes — over an INJECTED reader, so the walk itself is pure logic.
 *
 * The reader is the one impure seam: `readDir(path)` lists a directory's entries
 * (each a name + whether it is a directory). Everything else — descending the
 * tree, recognizing `page`/`layout` by name, accumulating segments — is
 * deterministic over what the reader returns, so the whole scan is exercised under
 * a fake in-memory reader with no filesystem. The bin wires a real reader
 * (`fs.readdir(..., { withFileTypes: true })`); a test hands a literal tree.
 *
 * Only the convention's recognized files (`page`, `layout`, `middleware`, and the
 * `loading` / `error` / `not-found` boundaries — any recognized extension) are
 * surfaced; every other file is ignored, so a co-located component, test, or
 * stylesheet under the convention dir is never mistaken for a route. The EXTENSION is irrelevant
 * to the convention — `page.tsx`, `page.ts`, `page.jsx`, `page.js` all name the
 * directory's page — because the impure loader (the bin) is what resolves a
 * concrete module path; the scan only needs the base name to classify the kind.
 */

import type { DiscoveredFile, FileRouteKind } from "./file-routes";
import { ROUTE_FILE_NAMES } from "./file-routes";

/** One entry the reader yields for a directory: its name and whether it is a subdir. */
export interface DirEntry {
  name: string;

  isDirectory: boolean;
}

/**
 * List a directory's immediate entries. The single impure seam of the scan — the
 * bin wires `fs.readdir(path, { withFileTypes: true })`, a test a literal map.
 * Async because a real filesystem read is.
 */
export type DirReader = (path: string) => Promise<ReadonlyArray<DirEntry>>;

/**
 * The base name of a route file is `<kind>.<ext>` — `page.tsx`, `layout.ts`,
 * `middleware.ts`, `not-found.tsx`. We split on the FIRST dot so a name like
 * `page.test.tsx` classifies as `page` only if its base is exactly `page`; a
 * co-located `page.helper.tsx` has base `page` too, so we additionally require the
 * name to be a recognized kind (`page`/`layout`/`middleware`/`loading`/`error`/
 * `not-found`) followed by a SINGLE extension. (A boundary's hyphen is part of its
 * base — `not-found` is one
 * base name, not a dot-delimited compound.) This pulls the base name (everything
 * before the first dot) and the remainder so the classifier can demand a single
 * extension segment.
 */
function baseAndExt(name: string): { base: string; rest: string } {
  const dot = name.indexOf(".");

  // A dotfile or extension-less name has no kind we recognize; `rest` empty marks it.
  if (dot <= 0) return { base: name, rest: "" };

  return { base: name.slice(0, dot), rest: name.slice(dot + 1) };
}

/**
 * Classify a file name as a route kind, or `undefined` if it is not one.
 *
 * A route file is exactly `page.<ext>` or `layout.<ext>` with a SINGLE extension
 * segment (no inner dot), so `page.tsx` and `layout.js` count while `page.test.tsx`,
 * `page.module.css`, and a bare `page` do not — a test or a co-located stylesheet
 * beside a real page is never mistaken for a second route file. The extension's
 * value does not matter (the loader resolves the concrete path); only that there
 * is exactly one.
 */
function kindOf(name: string): FileRouteKind | undefined {
  const { base, rest } = baseAndExt(name);

  const kind = ROUTE_FILE_NAMES[base];

  if (kind === undefined) return undefined;

  // Exactly one extension segment: a `rest` with its own dot (`test.tsx`,
  // `module.css`) is a co-located file, not the route file.
  if (rest === "" || rest.includes(".")) return undefined;

  return kind;
}

/**
 * Scan a convention directory into the flat {@link DiscoveredFile} list the
 * compiler takes, descending every subdirectory.
 *
 * `root` is the convention dir's own path (`app/`); the yielded segments are
 * relative to it, so the root's own `page`/`layout` arrive with an empty segment
 * chain and `app/listings/[id]/page.tsx` arrives as `segments: ["listings",
 * "[id]"]`. The walk is breadth-stable: a directory's own route files are recorded
 * before its children are descended, but the compiler re-orders for resolution, so
 * the discovery order here only needs to be COMPLETE, not sorted.
 *
 * A `[param]` directory is descended like any other — it is just a segment whose
 * name happens to compile to `:param` later; the scan stays oblivious to dynamic
 * vs static, which keeps the one place that distinction matters in the compiler.
 */
export async function scanRoutes(
  readDir: DirReader,
  root: string,
): Promise<ReadonlyArray<DiscoveredFile>> {
  const found: DiscoveredFile[] = [];

  // Descend `dir` (whose path is `path`, whose segments-from-root are `segments`),
  // recording its route files and recursing into its subdirectories.
  const walk = async (path: string, segments: ReadonlyArray<string>): Promise<void> => {
    const entries = await readDir(path);

    // Record this directory's own page/layout files first, then descend — order
    // within `found` is immaterial (the compiler sorts), so a simple two-pass over
    // the entries keeps the walk readable.
    for (const entry of entries) {
      if (entry.isDirectory) continue;

      const kind = kindOf(entry.name);

      if (kind !== undefined) {
        found.push({ kind, segments });
      }
    }

    // The subdirectories, walked in turn — each adds one raw segment (its name).
    const subdirs = entries.filter((entry) => entry.isDirectory);

    await Promise.all(
      subdirs.map((entry) => walk(joinPath(path, entry.name), [...segments, entry.name])),
    );
  };

  await walk(root, []);

  return found;
}

/**
 * Join a directory path and a child name with a single `/`. The scan never builds
 * absolute paths — it only re-feeds the result to the reader — so a plain slash
 * join is enough, and it keeps the (already-pure) walk free of a `node:path`
 * import that would tie it to one runtime.
 */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
