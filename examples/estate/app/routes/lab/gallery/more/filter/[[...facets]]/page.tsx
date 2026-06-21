/**
 * An OPTIONAL CATCH-ALL page — registered at `/lab/gallery/more/filter/*facets?`
 * because it lives at `more/filter/[[...facets]]/page.tsx` (ADR 0023, dx-parity W6).
 *
 * `[[...facets]]` compiles to `*facets?` — the ZERO-or-more twin of `[...]`. Unlike
 * a required catch-all, it ALSO matches the bare parent (`/lab/gallery/more/filter`,
 * `facets: []`), so one page serves both "no filters" and "these filters" without a
 * second route. The value is still a typed `string[]` (empty when none applied).
 */

import type { ReactNode } from "react";

import { Link } from "@lesto/ui";
import type { Context, PageDef, PageProps } from "@lesto/web";

const load = (c: Context<"/lab/gallery/more/filter/*facets?">) => ({ facets: c.param("facets") });

const page: PageDef<"/lab/gallery/more/filter/*facets?", PageProps<typeof load>> = {
  load,

  component: ({ facets }: PageProps<typeof load>): ReactNode => (
    <div data-file-route="more-optional-catch-all">
      <h2 className="section-title">Optional catch-all filters</h2>

      <p className="copy" data-facets>
        {facets.length === 0
          ? "No facets — this is the bare parent path (facets: [])."
          : `Filtering by: ${facets.join(", ")}`}
      </p>

      <p className="copy">
        <Link href="/lab/gallery/more/filter">Clear filters</Link> ·{" "}
        <Link href="/lab/gallery/more/filter/luxury/waterfront">Apply two</Link>
      </p>

      <p className="copy">
        <Link href="/lab/gallery/more">← Back to richer segments</Link>
      </p>
    </div>
  ),

  metadata: ({ facets }: PageProps<typeof load>) => ({
    title: facets.length === 0 ? "All listings · Filters" : `${facets.join(", ")} · Filters`,
    description: "An optional catch-all route that matches with zero or more segments.",
  }),
};

export default page;
