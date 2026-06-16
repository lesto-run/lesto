/**
 * The estate's hand-written pages — plain React components a `.page` renders.
 *
 * Each is a lean view (ADR 0004): the route's `load` produces props on the
 * server, the component renders them. The marketing pages (`HomePage`,
 * `AboutPage`) carry the `Account` island and are registered `static: true`, so
 * they prerender to cacheable HTML whose island still resolves the live session
 * on the client. `MlsPage` is dynamic — its `load` reads the request's session
 * and renders the matching `SignInPanel`.
 */

import type { ReactNode } from "react";

import { Copy, Hero, ListingGrid, Main, SiteHeader, SignInPanel } from "./ui/components";
import { AccountIsland } from "./ui/account-island";

/** The static home page: hero + listings, with the auth-aware Account island. */
export function HomePage(): ReactNode {
  return (
    <>
      <SiteHeader account={<AccountIsland />} />

      <Main>
        <Hero heading="Extraordinary homes, quietly sold." sub="Beverly Hills · Bel Air · Malibu" />

        <ListingGrid />
      </Main>
    </>
  );
}

/** The static about page — also carries the island, also prerenders. */
export function AboutPage(): ReactNode {
  return (
    <>
      <SiteHeader account={<AccountIsland />} />

      <Main>
        <Hero heading="About Jade" sub="Four decades at the top of luxury real estate." />

        <Copy text="This marketing site is prerendered to static HTML and served from a CDN — yet the Account control still reflects who you are, resolved on the client against the same-origin /mls session." />
      </Main>
    </>
  );
}

/** The props the MLS landing page renders from — produced by the route's `load`. */
export interface MlsPageProps {
  signedIn: boolean;
  name?: string;
  demoEmail?: string;
  demoPassword?: string;
}

/** The dynamic MLS landing page: server-rendered, with a real sign-in form. */
export function MlsPage({ signedIn, name, demoEmail, demoPassword }: MlsPageProps): ReactNode {
  return (
    <>
      <SiteHeader
        account={
          <SignInPanel
            signedIn={signedIn}
            {...(name === undefined ? {} : { name })}
            {...(demoEmail === undefined ? {} : { demoEmail })}
            {...(demoPassword === undefined ? {} : { demoPassword })}
          />
        }
      />

      <Main>
        <Hero
          heading={signedIn && name !== undefined ? `Welcome back, ${name}` : "MLS Search"}
          sub={signedIn ? "Your saved searches are at /mls/saved." : "Sign in to save listings."}
        />

        <ListingGrid />
      </Main>
    </>
  );
}
