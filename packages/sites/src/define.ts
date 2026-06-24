import { SitesError } from "./errors";
import type { Site } from "./types";

/** Normalize a basePath for collision comparison: drop a trailing slash, keep root. */
function normalizeBasePath(basePath: string): string {
  return basePath === "/" ? "/" : basePath.replace(/\/+$/, "");
}

/**
 * The characters a site name may use.
 *
 * A name is also a path segment — `outputPath` writes pages to `<name>/…` and the
 * build hook roots a sink at `out/<name>`. Constraining it to lowercase letters,
 * digits, `-`, and `_` means a name can never contain a `/`, a `..`, or anything
 * else that would let a write escape its output tree. The page sink (`nodeSink`)
 * already guards traversal, but the hook re-roots the sink at `out/<name>`, moving
 * that guard's anchor — so we validate the name once, here, the single source of
 * truth both paths read from, as cheap defense-in-depth.
 */
const VALID_NAME = /^[a-z0-9_-]+$/;

/**
 * Declare a project's sites.
 *
 * Validates the set up front — names are present and unique, base paths are
 * rooted and unique — so a typo is a clear error at config time, not a confusing
 * 404 (or ambiguous routing) at serve time. Returns the sites unchanged (and
 * fully typed) for the runtime and the build to consume.
 */
export function defineSites(sites: readonly Site[]): readonly Site[] {
  const seenNames = new Set<string>();
  const seenBasePaths = new Set<string>();

  for (const site of sites) {
    if (site.name === "") {
      throw new SitesError("SITES_EMPTY_NAME", "A site needs a non-empty name.");
    }

    // A name becomes a path segment in two places — `outputPath`'s `<name>/…` and
    // the build hook's `out/<name>` sink root. Reject anything that is not a plain
    // slug so neither write can ever escape its tree (e.g. a `../../x` name).
    if (!VALID_NAME.test(site.name)) {
      throw new SitesError(
        "SITES_INVALID_NAME",
        `Site name "${site.name}" must match ${VALID_NAME.source} (lowercase letters, digits, "-", "_").`,
        { name: site.name },
      );
    }

    if (seenNames.has(site.name)) {
      throw new SitesError("SITES_DUPLICATE_NAME", `Two sites share the name "${site.name}".`, {
        name: site.name,
      });
    }

    seenNames.add(site.name);

    if (!site.basePath.startsWith("/")) {
      throw new SitesError(
        "SITES_INVALID_BASE_PATH",
        `Site "${site.name}" has a basePath that does not start with "/": "${site.basePath}".`,
        { name: site.name, basePath: site.basePath },
      );
    }

    // Two zones at the same mount point would make selection ambiguous — the
    // request could belong to either. Reject it here, the one validation gate
    // every consumer (selection, dispatch, deploy routing) trusts.
    const normalized = normalizeBasePath(site.basePath);

    if (seenBasePaths.has(normalized)) {
      throw new SitesError(
        "SITES_DUPLICATE_BASE_PATH",
        `Two sites are mounted at the same basePath "${site.basePath}".`,
        { name: site.name, basePath: site.basePath },
      );
    }

    seenBasePaths.add(normalized);
  }

  return sites;
}
