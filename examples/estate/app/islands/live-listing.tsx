/**
 * `LiveListing` — the CSR (client-side) data-fetching island, as a canonical
 * `app/islands/` module (ADR 0011 Increment 2).
 *
 * The counterpart to the `Account` island's server-resolved data: this one mounts
 * fresh on the client (`ssr: false`) and fetches its listing itself, through the
 * typed `@lesto/client` over the `/lab/api/listings/:id` route. It is the demo of
 * "fetch on the client with end-to-end types" — `api.get` is constrained to the
 * shared {@link LabApi} contract, so the `:id` param and the `Listing` response
 * are both typed with no codegen. The server paints the fallback until it mounts.
 *
 * The fetch goes through `@lesto/ui`'s `useQuery` (the first reactive-data step, ADR 0027)
 * instead of a hand-rolled `useState`+`useEffect`+active-flag: the loading/error
 * machine is the hook's, the request is keyed (`["listing", id]`) so a second island
 * on the same id dedupes to one request, and the value is cached until invalidated.
 *
 * Default-exported (one island per file) so `@lesto/assets` synthesizes its
 * registration into the client entry — no hand-written `client.tsx`.
 */

import type { ReactNode } from "react";

import { defineIsland, useQuery } from "@lesto/ui";
import { createApi } from "@lesto/client";
import { readTraceparentMeta } from "@lesto/observability/rum";

import { formatPrice } from "../../src/listings";
import type { LabApi } from "../../src/lab-api";

// Same-origin typed client; the contract is the one the server route fulfils.
//
// The trace context (ARCHITECTURE.md §7): read the SSR-injected `lesto-traceparent`
// meta and, when present, hand the page's trace id to the client so this CSR data
// fetch carries an outbound `traceparent` continuing it — the server `/lab/api`
// handler then joins the SAME trace the page's browser RUM spans belong to, so the
// UI→API hop is one unbroken trace. Absent the meta (tracing off), the plain client.
const pageTrace = readTraceparentMeta();

const api = createApi<LabApi>(
  pageTrace === undefined ? {} : { trace: { traceId: pageTrace.traceId } },
);

/** The mounted island: fetch the listing by id (via useQuery), render its card. */
function LiveListingView({ listingId }: { listingId: string }): ReactNode {
  const {
    data: listing,
    error,
    isLoading,
  } = useQuery(["listing", listingId], () =>
    api.get("/lab/api/listings/:id", { params: { id: listingId } }),
  );

  if (isLoading) return <p className="copy">Loading {listingId} on the client…</p>;

  if (error !== undefined || listing === undefined) {
    return <p className="copy">Could not load {listingId}.</p>;
  }

  return (
    <article className="card">
      <h2>{listing.title}</h2>

      <p className="card__where">{listing.neighborhood}</p>

      <p className="card__price">{formatPrice(listing.price)}</p>

      <p className="copy">Fetched in the browser via @lesto/client + useQuery (deduped + cached).</p>
    </article>
  );
}

export default defineIsland({
  name: "LiveListing",
  component: LiveListingView,
  fallback: () => <p className="copy">Loading listing…</p>,
});
