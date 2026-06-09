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
    await sink(page.outputPath, page.html);
  }
}

/** The default sink: write each page under `rootDir` on the local filesystem. */
export function nodeSink(rootDir: string): OutputSink {
  const root = resolve(rootDir);

  return async (path, contents) => {
    const full = resolve(root, path);

    // A page path from untrusted content (a slug with `..`) must never escape
    // the output root. Resolve and confirm containment before touching disk.
    if (!full.startsWith(`${root}${sep}`)) {
      throw new SitesError(
        "SITES_PATH_ESCAPE",
        `Refusing to write "${path}" outside the output root.`,
        {
          path,
        },
      );
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  };
}
