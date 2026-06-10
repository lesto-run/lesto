/**
 * The real filesystem reader for prerendered static files.
 *
 * {@link dispatchSites} takes a `readStatic` so its core never touches disk and
 * stays a pure decision tree. This is the production implementation of that
 * port — a thin adapter over `node:fs/promises`, separately tested against a
 * real temp directory.
 *
 * Two invariants it guards:
 *   - A *missing* file is `undefined`, not a throw — that is a 404, not a crash.
 *     Any other error (a permission denial, a broken symlink) still throws, so a
 *     real fault is never silently swallowed into a 404.
 *   - The resolved file must stay *under* `outRoot`. A request path that climbs
 *     out with `..` is a traversal attempt and is refused, not served.
 *
 * It reads every file off disk as raw *bytes* (a `Buffer`), so an image, a font,
 * or a PDF is never corrupted by a UTF-8 round trip — the bug that made binary
 * static serving impossible. It then returns those bytes for a binary type and a
 * decoded UTF-8 `string` for a text type, decided from the extension by the same
 * {@link isBinaryType} table the dispatcher uses. So a text file (HTML, CSS, a
 * JSON feed) still comes back as a string — the original behavior, unchanged —
 * while a binary file comes back as bytes, intact.
 */

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { RuntimeError } from "./errors";
import { isBinaryType } from "./sites";

import type { StaticReader } from "./sites";

/** Node tags a "file not found" error with this code on its `errno` object. */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

/**
 * True iff `target` is `root` itself or sits somewhere beneath it.
 *
 * The trailing separator is what keeps `/srv/site-evil` from passing as "under"
 * `/srv/site`: we compare against `root + sep`, so only a real child matches.
 */
function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * A {@link StaticReader} backed by the local filesystem under `outRoot`.
 *
 * The dispatcher hands us an output path it built with `outputPath`; we resolve
 * it against `outRoot`, refuse anything that escaped the root, and read it —
 * mapping a missing file to `undefined` so the caller renders a clean 404.
 */
export function nodeStaticReader(outRoot: string): StaticReader {
  const root = resolve(outRoot);

  return async (filePath) => {
    const resolved = resolve(root, filePath);

    if (!isWithin(root, resolved)) {
      throw new RuntimeError(
        "RUNTIME_STATIC_PATH_TRAVERSAL",
        `Refusing to read "${filePath}": it resolves outside the site root.`,
        { outRoot: root, filePath, resolved },
      );
    }

    try {
      // Read raw bytes off disk, never UTF-8: a binary file must not be
      // corrupted on the way in. Then return bytes for a binary type, or a
      // decoded string for a text type — so a text file's contract is unchanged.
      const bytes = await readFile(resolved);

      return isBinaryType(resolved) ? bytes : bytes.toString("utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;

      throw error;
    }
  };
}
