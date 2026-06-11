/**
 * Versioned releases: publish immutably, verify, then flip a pointer.
 *
 * `shipStatic` alone is a copy — it overwrites the live tree in place, so a
 * half-finished publish is half-live and there is nothing to roll back to. A
 * *release* publishes every file under an immutable `releases/<version>/`
 * prefix first, runs an optional health gate over the staged release, and only
 * then flips the `current` pointer — one atomic operation, so traffic moves
 * from the old release to the new one in a single step and never sees a
 * partial tree. Rolling back is the same flip, pointed at a previous version.
 *
 * The store is a seam ({@link ReleaseStore}): the node implementation
 * ({@link nodeReleaseStore}) uses the classic on-disk shape — version
 * directories plus a `current` symlink swapped via rename, which POSIX makes
 * atomic — while a CDN/object-store backend would implement the same five
 * functions over its own primitives. Tests drive the logic with an in-memory
 * store and assert the order: files, then gate, then pointer.
 */

import { mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { DeployError } from "./errors";
import { nodeUploader, shipStatic } from "./ship";
import type { ShipDeps } from "./ship";
import type { StaticTarget } from "./plan";

/**
 * Where releases live: the uploader surface plus the release bookkeeping.
 *
 * `setCurrent` MUST be atomic — it is the cutover. `getCurrent` reads the live
 * pointer (`undefined` before the first release); `listReleases` names every
 * published version so a rollback can refuse a typo instead of flipping the
 * site to a directory that does not exist.
 */
export interface ReleaseStore extends ShipDeps {
  /** Atomically point the live site at `version`. */
  readonly setCurrent: (version: string) => Promise<void>;

  /** The version currently live, or `undefined` before the first release. */
  readonly getCurrent: () => Promise<string | undefined>;

  /** Every published version, unordered. */
  readonly listReleases: () => Promise<readonly string[]>;
}

/** What one release published, and what it replaced. */
export interface Release {
  readonly version: string;

  readonly site: string;

  /** Every route published, in publish order. */
  readonly routes: readonly string[];

  /** The version that was live before this one — the one-step rollback target. */
  readonly previous?: string;
}

/** How to ship a release: its version stamp and an optional pre-flip gate. */
export interface ShipReleaseOptions {
  /** The release's version — a single path segment (it names the directory). */
  readonly version: string;

  /**
   * The health gate, run after the files are staged and BEFORE the pointer
   * flips. Return `false` (or throw) and the flip is refused: the staged
   * release stays on disk for inspection, the live pointer never moves, and
   * `DEPLOY_RELEASE_UNHEALTHY` surfaces to the caller. Absent, the release
   * flips once its files are staged (the build itself already render-gated
   * them via `buildStaticSites`).
   */
  readonly verify?: (release: Omit<Release, "previous">) => Promise<boolean>;
}

/** The prefix every release's files live under. */
const RELEASES_DIR = "releases";

/** Refuse a version that cannot be a single, safe path segment. */
function assertVersionSegment(version: string): void {
  if (version === "" || version === "." || version === ".." || /[/\\]/.test(version)) {
    throw new DeployError(
      "DEPLOY_BAD_VERSION",
      `A release version must be a single path segment; got "${version}".`,
      { version },
    );
  }
}

/**
 * Publish `target` as an immutable release, gate it, then flip `current` to it.
 *
 * The order is the contract: every file lands under `releases/<version>/`
 * first (reusing `shipStatic`'s loop through a key-prefixing view of the
 * store), the optional `verify` gate then inspects the staged release, and
 * only after it passes does the pointer move — so the live site is always a
 * complete, verified tree, never a partial one.
 */
export async function shipRelease(
  target: StaticTarget,
  outRoot: string,
  store: ReleaseStore,
  options: ShipReleaseOptions,
): Promise<Release> {
  assertVersionSegment(options.version);

  // The same publish loop a plain ship runs, with every key staged under the
  // release's immutable prefix.
  const staged: ShipDeps = {
    read: store.read,
    put: (key, contents, contentType) =>
      store.put(`${RELEASES_DIR}/${options.version}/${key}`, contents, contentType),
  };

  const { site, routes } = await shipStatic(target, outRoot, staged);

  const release = { version: options.version, site, routes };

  if (options.verify !== undefined && !(await options.verify(release))) {
    throw new DeployError(
      "DEPLOY_RELEASE_UNHEALTHY",
      `Release "${options.version}" failed its health gate; the live pointer was not moved.`,
      { version: options.version, site },
    );
  }

  const previous = await store.getCurrent();

  await store.setCurrent(options.version);

  return previous === undefined ? release : { ...release, previous };
}

/**
 * Point the live site back at an already-published release.
 *
 * Refuses a version that was never published (`DEPLOY_UNKNOWN_RELEASE`) — a
 * rollback under pressure must not be able to flip the site to nowhere.
 */
export async function rollback(
  store: ReleaseStore,
  version: string,
): Promise<{ from?: string; to: string }> {
  const releases = await store.listReleases();

  if (!releases.includes(version)) {
    throw new DeployError("DEPLOY_UNKNOWN_RELEASE", `No release "${version}" to roll back to.`, {
      version,
      known: [...releases],
    });
  }

  const from = await store.getCurrent();

  await store.setCurrent(version);

  return from === undefined ? { to: version } : { from, to: version };
}

/**
 * The on-disk release store: version directories plus a `current` symlink.
 *
 * Files publish through the same path-escape-checked uploader a plain ship
 * uses. The cutover is the classic atomic-on-POSIX move: write a fresh symlink
 * beside `current`, then `rename` it over — readers see the old tree or the
 * new one, never neither. A static file server (or `nodeStaticReader`) points
 * at `<distRoot>/current` and follows the link.
 */
export function nodeReleaseStore(distRoot: string): ReleaseStore {
  const dist = resolve(distRoot);

  const uploader = nodeUploader(distRoot);

  return {
    ...uploader,

    setCurrent: async (version) => {
      assertVersionSegment(version);

      await mkdir(dist, { recursive: true });

      // Symlink rename is the atomic flip; symlink() refuses to overwrite, so
      // stage a fresh link and rename it over the live one.
      const staging = join(dist, ".current-staging");

      await rm(staging, { force: true });
      await symlink(join(RELEASES_DIR, version), staging);
      await rename(staging, join(dist, "current"));
    },

    getCurrent: async () => {
      try {
        return basename(await readlink(join(dist, "current")));
      } catch {
        return undefined;
      }
    },

    listReleases: async () => {
      try {
        return await readdir(join(dist, RELEASES_DIR));
      } catch {
        return [];
      }
    },
  };
}
