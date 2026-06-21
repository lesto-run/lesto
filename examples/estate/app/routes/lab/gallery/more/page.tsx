/**
 * The "richer segments" index — registered at `/lab/gallery/more` (ADR 0023,
 * dx-parity W6).
 *
 * A STATIC `page.tsx` here outranks the sibling `[id]` dynamic route for this exact
 * path — a literal segment beats a `:param` at the same position — so
 * `/lab/gallery/more` lands HERE, not on the listing-detail page. It links out to
 * the three richer file-route segment kinds W6 added: a catch-all, an optional
 * catch-all, and a route group.
 */

import type { ReactNode } from "react";

import { Link } from "@lesto/ui";
import type { PageDef } from "@lesto/web";

const page: PageDef<"/lab/gallery/more"> = {
  component: (): ReactNode => (
    <div data-file-route="more-index">
      <h2 className="section-title">Richer route segments</h2>

      <ul className="copy">
        <li>
          <Link href="/lab/gallery/more/path/downtown/lofts">
            Catch-all <code>[...crumbs]</code> → a whole trailing path as a typed{" "}
            <code>string[]</code>
          </Link>
        </li>
        <li>
          <Link href="/lab/gallery/more/filter">
            Optional catch-all <code>[[...facets]]</code> → matches with zero segments…
          </Link>
        </li>
        <li>
          <Link href="/lab/gallery/more/filter/luxury/3-bed">…and with many</Link>
        </li>
        <li>
          <Link href="/lab/gallery/more/about">
            Route group <code>(notes)</code> → a pathless folder (no URL segment)
          </Link>
        </li>
      </ul>
    </div>
  ),

  metadata: () => ({
    title: "Richer segments · Jade Mills Estates",
    description: "Catch-all, optional catch-all, and route-group file-route segments.",
  }),
};

export default page;
