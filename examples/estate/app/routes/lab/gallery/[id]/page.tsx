/**
 * One listing's detail page — registered at `/lab/gallery/:id` because it lives at
 * `app/routes/gallery/[id]/page.tsx` (ADR 0023).
 *
 * The `[id]` directory is the convention's dynamic segment: it compiles to the
 * router's `:id`, so the page's `load` reads it with the SAME typed `c.param("id")`
 * a hand-written `.page("/gallery/:id", …)` would — the file convention inherits
 * the code-first router's typed params unchanged. An unknown id renders a
 * not-found view rather than throwing, so a stale `<Link>` degrades gracefully.
 */

import type { ReactNode } from "react";

import { Link } from "@lesto/ui";
import type { PageDef } from "@lesto/web";

import { findListing, formatPrice } from "../../../../../src/listings";
import type { Listing } from "../../../../../src/listings";

interface ListingProps {
  id: string;
  listing: Listing | undefined;
}

const page: PageDef<"/lab/gallery/:id", ListingProps> = {
  // The typed `:id` the `[id]` directory compiled to — read the same way a
  // code-first route's `load` reads its params.
  load: (c) => {
    const id = c.param("id");

    return { id, listing: findListing(id) };
  },

  component: ({ id, listing }: ListingProps): ReactNode => {
    if (listing === undefined) {
      return (
        <div data-file-route="gallery-detail-missing">
          <h2 className="section-title">No such listing</h2>

          <p className="copy">
            Nothing is filed under <code>{id}</code>.{" "}
            <Link href="/lab/gallery">See the whole gallery →</Link>
          </p>
        </div>
      );
    }

    return (
      <article data-file-route="gallery-detail">
        <h2 className="section-title">{listing.title}</h2>

        <p className="copy">
          {listing.neighborhood} · {formatPrice(listing.price)} · {listing.beds} bd /{" "}
          {listing.baths} ba
        </p>

        <p className="copy">
          Routed by file path <code>gallery/[id]/page.tsx</code>, with the typed
          param <code data-param-id>{id}</code> read off <code>c.param(&quot;id&quot;)</code>.
        </p>
      </article>
    );
  },

  metadata: ({ listing, id }: ListingProps) => ({
    title: listing === undefined ? "Not found" : `${listing.title} · Gallery`,
    description:
      listing === undefined
        ? `No listing filed under ${id}.`
        : `${listing.title} in ${listing.neighborhood}.`,
  }),
};

export default page;
