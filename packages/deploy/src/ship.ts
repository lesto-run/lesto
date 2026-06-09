/**
 * Shipping a static target: publish its files through an injected uploader.
 *
 * `shipStatic` owns the loop and the order — read each file from the build
 * output, hand it to the uploader with its route and Content-Type. It never
 * touches S3 or HTTP itself; the uploader is the seam. The default uploader
 * ({@link nodeUploader}) is a thin filesystem copy, tested on its own; tests of
 * the loop pass an in-memory uploader and assert on what it captured.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { DeployError } from "./errors";
import type { StaticTarget } from "./plan";

/**
 * The IO seams `shipStatic` depends on, injected so the loop is pure logic.
 *
 * `read` pulls a built file's contents from the output root; `put` publishes
 * those contents at a route with a Content-Type. Together they are the whole
 * surface a destination — S3, a CDN API, the local disk, a test's map — must
 * implement.
 */
export interface ShipDeps {
  /** Read a built file's contents, given the output root and the file's path. */
  readonly read: (outRoot: string, file: string) => Promise<string>;

  /**
   * Publish one file's contents under `key` with its Content-Type.
   *
   * `key` is the file's structural path (e.g. `marketing/about/index.html`) —
   * the thing that reconstructs a servable tree on disk and that a CDN keys an
   * object by. The public route travels in the {@link ShipResult}, not here, so
   * the seam stays a plain put without route math leaking into every backend.
   */
  readonly put: (key: string, contents: string, contentType: string) => Promise<void>;
}

/** What one shipped target published: its site and the routes that went live. */
export interface ShipResult {
  readonly site: string;

  /** Every route published, in publish order. */
  readonly routes: readonly string[];
}

/**
 * Publish a static target's files from `outRoot` through the injected uploader.
 *
 * Each file is read from the build output and put at its public route with the
 * Content-Type the plan resolved. Files publish in plan order; we return the
 * routes that went live so a caller can log or verify the deploy.
 */
export async function shipStatic(
  target: StaticTarget,
  outRoot: string,
  deps: ShipDeps,
): Promise<ShipResult> {
  const routes: string[] = [];

  for (const { file, route, contentType } of target.files) {
    const contents = await deps.read(outRoot, file);

    await deps.put(file, contents, contentType);

    routes.push(route);
  }

  return { site: target.site, routes };
}

/**
 * The default uploader: copy each file from the build output into `distRoot`.
 *
 * This is the "ship to a local directory" target — the honest no-cloud default,
 * the same shape a CDN-backed uploader would take. It reads from the build
 * output and writes under `distRoot` keyed by the file's structural path, so the
 * published tree mirrors the build tree a static host expects. Like the sites
 * sink, it refuses to write outside its root.
 */
export function nodeUploader(distRoot: string): ShipDeps {
  const dist = resolve(distRoot);

  return {
    read: (outRoot, file) => readFile(resolve(outRoot, file), "utf8"),

    put: async (key, contents) => {
      const full = resolve(dist, key);

      // `key` is a build `outputPath`, but treat it as untrusted: confirm the
      // resolved file stays inside the dist root before touching disk.
      if (!full.startsWith(`${dist}${sep}`)) {
        throw new DeployError(
          "DEPLOY_PATH_ESCAPE",
          `Refusing to publish "${key}" outside the dist root.`,
          { key },
        );
      }

      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, "utf8");
    },
  };
}
