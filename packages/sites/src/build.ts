import { SitesError } from "./errors";
import { prerenderSite } from "./prerender";
import { writePages } from "./write";
import type { OutputSink, PageHandler, RenderedPage, Site, StaticSite } from "./types";

/** One static site's place in the build manifest: its name and what it produced. */
export interface SiteManifest {
  /** The site's name (also its output directory). */
  readonly site: string;

  /** Every page written for this site, in render order. */
  readonly pages: readonly {
    readonly path: string;

    readonly outputPath: string;

    readonly status: number;
  }[];
}

/** A page the app could not render, named for the error that refuses the build. */
interface PageFailure {
  readonly site: string;

  readonly path: string;

  readonly status: number;
}

/** A page rendered cleanly when the app answered it with a 2xx status. */
function isOk(page: RenderedPage): boolean {
  return page.status >= 200 && page.status < 300;
}

/** Narrow a site set to the static ones — the only sites a build prerenders. */
function staticSites(sites: readonly Site[]): readonly StaticSite[] {
  return sites.filter((site): site is StaticSite => site.render === "static");
}

/** The manifest entry for a site, the rendered pages reduced to their shape. */
function manifestFor(site: StaticSite, pages: readonly RenderedPage[]): SiteManifest {
  return {
    site: site.name,
    pages: pages.map((page) => ({
      path: page.path,
      outputPath: page.outputPath,
      status: page.status,
    })),
  };
}

/** A one-line "/path (status)" rendering of a failure, for the error message. */
function describe(failure: PageFailure): string {
  return `${failure.site} ${failure.path} (${failure.status})`;
}

/**
 * Build a project's static sites: prerender each, then write them — but only if
 * every page rendered cleanly.
 *
 * This is `next export`'s contract: never ship a broken build. We prerender all
 * static sites first and collect every page the app answered with a non-2xx
 * status; if ANY page failed, we throw before a single file is written, naming
 * the paths and statuses that failed. Dynamic sites are served live, so they are
 * skipped here. On success every page is written through the sink and a manifest
 * of what was built is returned.
 */
export async function buildStaticSites(
  sites: readonly Site[],
  handle: PageHandler,
  sink: OutputSink,
): Promise<readonly SiteManifest[]> {
  const targets = staticSites(sites);

  // Prerender every static site before writing anything: the build is all-or-
  // nothing, so we must see all failures before we touch the sink.
  const rendered = await Promise.all(
    targets.map(async (site) => ({ site, pages: await prerenderSite(site, handle) })),
  );

  const failures: PageFailure[] = rendered.flatMap(({ site, pages }) =>
    pages
      .filter((page) => !isOk(page))
      .map((page) => ({ site: site.name, path: page.path, status: page.status })),
  );

  // A single broken page fails the whole build — and writes nothing.
  if (failures.length > 0) {
    throw new SitesError(
      "SITES_PAGE_FAILED",
      `Refusing to write a broken build — these pages did not render: ${failures.map(describe).join(", ")}.`,
      { failures },
    );
  }

  // Every page rendered cleanly: commit them all through the sink.
  for (const { pages } of rendered) {
    await writePages(pages, sink);
  }

  return rendered.map(({ site, pages }) => manifestFor(site, pages));
}
