import { SitesError } from "./errors";
import type { Site } from "./types";

/**
 * Declare a project's sites.
 *
 * Validates the set up front — names are present and unique, base paths are
 * rooted — so a typo is a clear error at config time, not a confusing 404 at
 * serve time. Returns the sites unchanged (and fully typed) for the runtime and
 * the build to consume.
 */
export function defineSites(sites: readonly Site[]): readonly Site[] {
  const seen = new Set<string>();

  for (const site of sites) {
    if (site.name === "") {
      throw new SitesError("SITES_EMPTY_NAME", "A site needs a non-empty name.");
    }

    if (seen.has(site.name)) {
      throw new SitesError("SITES_DUPLICATE_NAME", `Two sites share the name "${site.name}".`, {
        name: site.name,
      });
    }

    seen.add(site.name);

    if (!site.basePath.startsWith("/")) {
      throw new SitesError(
        "SITES_INVALID_BASE_PATH",
        `Site "${site.name}" has a basePath that does not start with "/": "${site.basePath}".`,
        { name: site.name, basePath: site.basePath },
      );
    }
  }

  return sites;
}
