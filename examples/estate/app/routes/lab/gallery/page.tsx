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

import { Link } from "@lesto/ui";
import type { PageDef } from "@lesto/web";

import { LISTINGS, formatPrice } from "../../../../src/listings";
import type { Listing } from "../../../../src/listings";

interface GalleryProps {
  listings: readonly Listing[];
}

/** The default export IS the PageDef the applier registers — view + server load. */
const page: PageDef<"/lab/gallery", GalleryProps> = {
  load: () => ({ listings: LISTINGS }),

  component: ({ listings }: GalleryProps): ReactNode => (
    <div data-file-route="gallery-index">
      <h2 className="section-title">The gallery</h2>

      <ul className="copy">
        {listings.map((listing) => (
          <li key={listing.id}>
            <Link href={`/lab/gallery/${listing.id}`}>
              {listing.title} — {formatPrice(listing.price)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  ),

  metadata: () => ({
    title: "Gallery · Jade Mills Estates",
    description: "A file-routed gallery of listings, each its own dynamic page.",
  }),
};

export default page;
