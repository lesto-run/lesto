/**
 * The gallery index — registered at `/lab/gallery` purely by living at
 * `app/routes/gallery/page.tsx` (ADR 0023).
 *
 * A `page.tsx` makes its directory's URL a route; the directory chain
 * `gallery/` compiles to the pattern `/gallery`, which the demo mounts under
 * `/lab`. Its `load` runs on the server (the same `PageDef.load` a hand-written
 * `.page` uses), and each listing links to its `[id]` detail page with a `<Link>`,
 * so clicking one soft-navigates (ADR 0024) instead of reloading the document.
 */

import type { ReactNode } from "react";

import { Link, route } from "@lesto/ui";
import type { PageDef, PageProps } from "@lesto/web";

import { LISTINGS, formatPrice } from "../../../../src/listings";

/**
 * The server load. Pulled out as a `const` so the component's props are INFERRED
 * from its return via `PageProps<typeof load>` — the shape is declared once, with no
 * restated interface (the pattern `lesto g page` emits).
 */
const load = () => ({ listings: LISTINGS });

/** The default export IS the PageDef the applier registers — view + server load. */
const page: PageDef<"/lab/gallery", PageProps<typeof load>> = {
  load,

  component: ({ listings }: PageProps<typeof load>): ReactNode => (
    <div data-file-route="gallery-index">
      <h2 className="section-title">The gallery</h2>

      <ul className="copy">
        {listings.map((listing) => (
          <li key={listing.id}>
            <Link href={route("/lab/gallery/:id", { id: listing.id })}>
              {listing.title} — {formatPrice(listing.price)}
            </Link>
          </li>
        ))}
      </ul>

      <p className="copy">
        <Link href="/lab/gallery/more">Richer route segments → catch-all, optional, group</Link>
      </p>

      <p className="copy">
        <Link href="/lab/gallery/secret?key=jade">
          The pocket listing → guarded by a co-located <code>middleware.ts</code>
        </Link>
      </p>
    </div>
  ),

  metadata: () => ({
    title: "Gallery · Jade Mills Estates",
    description: "A file-routed gallery of listings, each its own dynamic page.",
  }),
};

export default page;
