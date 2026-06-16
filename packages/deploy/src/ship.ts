/**
 * Shipping a static target: publish its files through an injected uploader.
 *
 * `shipStatic` owns the loop and the order — read each file from the build
 * output, hand it to the uploader with its route and Content-Type. It never
 * touches S3 or HTTP itself; the uploader is the seam. The default uploader
 * ({@link nodeUploader}) is a thin filesystem copy, tested on its own; tests of
 * the loop pass an in-memory uploader and assert on what it captured.
 *
 * The seam carries **bytes** (`Uint8Array`), not strings. A string seam decodes
 * every payload as text, which silently corrupts any non-text asset — a PNG, a
 * woff2 font, a gzip blob — the moment it flows through. `read` returns the
 * file's raw bytes and `put` takes raw bytes; a `string` convenience overload on
 * `put` UTF-8-encodes text for the common HTML/CSS/JS case, so existing string
 * call sites keep working unchanged while binary assets round-trip bit-exact.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { DeployError } from "./errors";
import type { StaticTarget } from "./plan";

/**
 * Publish one file's bytes under `key` with its Content-Type.
 *
 * The canonical arm takes a `Uint8Array` — the lossless seam every backend
 * implements. A `string` convenience overload UTF-8-encodes text for the common
 * page/feed/asset case, so a caller holding HTML need not encode by hand and
 * every pre-bytes call site keeps compiling.
 *
 * `key` is the file's structural path (e.g. `marketing/about/index.html`) — the
 * thing that reconstructs a servable tree on disk and that a CDN keys an object
 * by. The public route travels in the {@link ShipResult}, not here, so the seam
 * stays a plain put without route math leaking into every backend.
 */
export interface Put {
  (key: string, contents: Uint8Array, contentType: string): Promise<void>;
  (key: string, contents: string, contentType: string): Promise<void>;
}

/**
 * The IO seams `shipStatic` depends on, injected so the loop is pure logic.
 *
 * `read` pulls a built file's raw bytes from the output root; `put` publishes
 * those bytes at a route with a Content-Type. Together they are the whole
 * surface a destination — S3, a CDN API, the local disk, a test's map — must
 * implement, and they carry `Uint8Array` so binary assets survive intact.
 */
export interface ShipDeps {
  /** Read a built file's raw bytes, given the output root and the file's path. */
  readonly read: (outRoot: string, file: string) => Promise<Uint8Array>;

  /** Publish one file's bytes (or, conveniently, text) under `key`. */
  readonly put: Put;
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
 * Each file is read from the build output as raw bytes and put at its public
 * route with the Content-Type the plan resolved — bytes in, bytes out, so a PNG
 * or font is byte-identical at the destination. Files publish in plan order; we
 * return the routes that went live so a caller can log or verify the deploy.
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
 * the same shape a CDN-backed uploader would take. It reads raw bytes from the
 * build output and writes them under `distRoot` keyed by the file's structural
 * path, so the published tree mirrors the build tree a static host expects —
 * binary assets included, byte for byte. Like the sites sink, it refuses to
 * write outside its root.
 */
export function nodeUploader(distRoot: string): ShipDeps {
  const dist = resolve(distRoot);

  return {
    // No encoding: read the file as bytes so a non-text asset is not decoded
    // (and thereby corrupted) on its way through the seam.
    read: (outRoot, file) => readFile(resolve(outRoot, file)),

    put: (key: string, contents: Uint8Array | string): Promise<void> => {
      const full = resolve(dist, key);

      // `key` is a build `outputPath`, but treat it as untrusted: confirm the
      // resolved file stays inside the dist root before touching disk.
      if (!full.startsWith(`${dist}${sep}`)) {
        return Promise.reject(
          new DeployError(
            "DEPLOY_PATH_ESCAPE",
            `Refusing to publish "${key}" outside the dist root.`,
            { key },
          ),
        );
      }

      // `writeFile` takes a string or bytes; the string arm lands as UTF-8, the
      // bytes arm lands verbatim — the fidelity the seam exists to guarantee.
      return mkdir(dirname(full), { recursive: true }).then(() => writeFile(full, contents));
    },
  };
}
