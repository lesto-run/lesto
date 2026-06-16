/**
 * The `/lab` zone — a gallery of framework features, each on its own `.page`.
 *
 * Where the marketing zone shows auth-aware static and `/mls` shows the real app,
 * `/lab` is the deliberate test-bench: one page per capability, composed as a sub
 * app that `controllers.ts` mounts (so every lab page inherits the EstateLayout +
 * the root's client runtime + secureStack). It exercises, end to end:
 *
 *   - SSR data fetching + a typed `:id` param      (`/lab/listings/:id`)
 *   - shell-first streaming with `<Suspense>`       (`/lab/streaming`)
 *   - CSR data fetching through the typed client    (`/lab` — the LiveListing island)
 *   - feature flags (`@keel/flags`, off → 404)      (`/lab/flags`)
 *   - authorization (`@keel/authz`, deny-by-default)(`/lab/admin`)
 *   - the data route the CSR island calls           (`GET /lab/api/listings/:id`)
 */

import { Suspense, use } from "react";
import type { ReactNode } from "react";

import { keel } from "@keel/web";
import type { Handler, Keel } from "@keel/web";
import { defineFlags } from "@keel/flags";
import { createGuard, definePolicy } from "@keel/authz";

import { Button, Hero, ListingCard, Main, Section, SiteHeader } from "./ui/components";
import { LiveListing } from "./ui/live-listing";
import { LISTINGS, findListing, formatPrice } from "./listings";
import type { Listing } from "./listings";

// A flag that gates the preview page: off by default (→ 404), flipped on by the
// dynamic `?preview=1` escape hatch (the static default otherwise wins).
const flags = defineFlags({
  defaults: { "lab-preview": false },
  resolve: (_flag, c) => (c.query("preview") === "1" ? true : undefined),
});

// One policy, deny-by-default: only the `admin` role may reach `lab.admin`.
const policy = definePolicy({
  roles: ["guest", "admin"],
  can: { "lab.admin": ["admin"] },
});
const { can } = createGuard(policy);

// A demo roles middleware: in a real app the roles come from the session; here
// `?role=admin` is the knob, so the authz demo is self-contained.
const withDemoRole: Handler = (c, next) => {
  c.set("roles", c.query("role") === "admin" ? ["admin"] : ["guest"]);

  return next();
};

/** The lab landing page: links to each demo + the live (CSR) listing island. */
function LabIndex(): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero
          heading="Framework Lab"
          sub="One page per capability — the playground's test bench."
        />

        <Section title="Pages">
          <p className="copy">
            <Button href="/lab/listings/bel-air-glen">SSR data + typed param</Button>{" "}
            <Button href="/lab/streaming">Streaming &lt;Suspense&gt;</Button>{" "}
            <Button variant="ghost" href="/lab/flags?preview=1">
              Feature flag
            </Button>{" "}
            <Button variant="ghost" href="/lab/admin?role=admin">
              Authorization
            </Button>
          </p>
        </Section>

        <Section title="CSR data fetching (the LiveListing island)">
          <p className="copy">
            This card is fetched in the BROWSER, after hydration, through the typed @keel/client —
            the client-side twin of the server-resolved Account island.
          </p>

          <LiveListing listingId="malibu-cliff" />
        </Section>
      </Main>
    </>
  );
}

/** SSR data fetching + a typed `:id` param: the listing is resolved on the server. */
function ListingDetailPage({
  id,
  listing,
}: {
  id: string;
  listing: Listing | undefined;
}): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        {listing === undefined ? (
          <Hero heading="Not found" sub={`No listing "${id}".`} />
        ) : (
          <>
            <Hero
              heading={listing.title}
              sub={`${listing.neighborhood} · ${formatPrice(listing.price)}`}
            />

            <Section title="Resolved on the server">
              <ListingCard
                title={listing.title}
                neighborhood={listing.neighborhood}
                price={formatPrice(listing.price)}
                beds={listing.beds}
                baths={listing.baths}
              />
            </Section>
          </>
        )}
      </Main>
    </>
  );
}

/** A deliberately slow data source, to make the streaming boundary observable. */
function slowListings(): Promise<readonly Listing[]> {
  return new Promise((resolve) => setTimeout(() => resolve(LISTINGS), 30));
}

/** The suspending child: it `use()`s the promise, so the shell streams before it. */
function ResolvedListings({ promise }: { promise: Promise<readonly Listing[]> }): ReactNode {
  const listings = use(promise);

  return (
    <section className="grid">
      {listings.map((listing) => (
        <ListingCard
          key={listing.id}
          title={listing.title}
          neighborhood={listing.neighborhood}
          price={formatPrice(listing.price)}
          beds={listing.beds}
          baths={listing.baths}
        />
      ))}
    </section>
  );
}

/** Shell-first streaming: the header + hero paint immediately, listings stream in. */
function StreamingPage({
  listingsPromise,
}: {
  listingsPromise: Promise<readonly Listing[]>;
}): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero
          heading="Streaming"
          sub="The shell paints first; the listings stream in when ready."
        />

        <Suspense fallback={<p className="copy">Streaming the listings…</p>}>
          <ResolvedListings promise={listingsPromise} />
        </Suspense>
      </Main>
    </>
  );
}

/** The flag-gated page — only reachable when `lab-preview` resolves on. */
function FlagPage(): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero
          heading="Preview feature"
          sub="You reached this because the lab-preview flag is on."
        />
      </Main>
    </>
  );
}

/** The authorized page — only reachable for the `admin` role. */
function AdminPage(): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero heading="Admin only" sub="Cleared the lab.admin policy (deny-by-default)." />
      </Main>
    </>
  );
}

/** Build the `/lab` sub-app — mounted by `controllers.ts`. */
export function buildLabRoutes(): Keel {
  // The flag- and authz-gated pages live in their own sub-routers so the gate
  // wraps ONLY that page, not the whole lab zone.
  const flagGated = keel()
    .use(flags.gate("lab-preview"))
    .page("/lab/flags", { component: FlagPage });

  const adminGated = keel()
    .use(withDemoRole)
    .use(can("lab.admin"))
    .page("/lab/admin", { component: AdminPage });

  return (
    keel()
      .page("/lab", { component: LabIndex })
      .page("/lab/listings/:id", {
        load: (c) => {
          const id = c.param("id");

          return { id, listing: findListing(id) };
        },
        component: ListingDetailPage,
      })
      .page("/lab/streaming", {
        load: () => ({ listingsPromise: slowListings() }),
        component: StreamingPage,
      })
      .route(flagGated)
      .route(adminGated)
      // The data route the LiveListing island fetches (typed by `LabApi`).
      .get("/lab/api/listings/:id", (c) => {
        const listing = findListing(c.param("id"));

        return listing === undefined ? c.json({ error: "not found" }, 404) : c.json(listing);
      })
  );
}
