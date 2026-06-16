import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { SitesError } from "./errors";
import type { OutputSink, RenderedPage } from "./types";

/**
 * Write prerendered pages through a sink.
 *
 * The sink is the only thing that touches the outside world, so the same pages
 * can land on disk, in S3, or in a test's in-memory map without changing this.
 */
export async function writePages(pages: readonly RenderedPage[], sink: OutputSink): Promise<void> {
  for (const page of pages) {
    // Write the raw bytes, not the decoded `html` view — a binary route must
    // land byte-identical, and a string seam would corrupt it.
    await sink(page.outputPath, page.body);
  }
}

/**
 * The default sink: write each page under `rootDir` on the local filesystem.
 *
 * Bytes go to disk verbatim; the `string` convenience overload lands as UTF-8 —
 * so a caller can hand the sink HTML text or raw asset bytes, and both arrive
 * intact.
 */
export function nodeSink(rootDir: string): OutputSink {
  const root = resolve(rootDir);

  return (path: string, contents: Uint8Array | string): Promise<void> => {
    const full = resolve(root, path);

    // A page path from untrusted content (a slug with `..`) must never escape
    // the output root. Resolve and confirm containment before touching disk.
    if (!full.startsWith(`${root}${sep}`)) {
      return Promise.reject(
        new SitesError(
          "SITES_PATH_ESCAPE",
          `Refusing to write "${path}" outside the output root.`,
          {
            path,
          },
        ),
      );
    }

    // `writeFile` lands a string as UTF-8 and bytes verbatim — the fidelity the
    // byte seam exists to guarantee.
    return mkdir(dirname(full), { recursive: true }).then(() => writeFile(full, contents));
  };
}
