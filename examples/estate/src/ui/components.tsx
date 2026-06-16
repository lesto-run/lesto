/**
 * The estate site's component vocabulary — plain React, no UiNode tree.
 *
 * These replace the old `registry.tsx` server components (ADR 0004: hand-written
 * pages are ordinary React, the `Registry`/UiNode path is reserved for DB-driven
 * content — see `content-registry.tsx`). Each is a small, typed presentational
 * component the `.page` components compose. The markup and class names match the
 * `styles.ts` design system.
 */

import type { ReactNode } from "react";

import { LISTINGS, formatPrice } from "../listings";

/** The top bar: brand, nav, and the account slot (an island, or a sign-in panel). */
export function SiteHeader({ account }: { account?: ReactNode }): ReactNode {
  return (
    <header className="site">
      <a className="site__brand" href="/">
        Jade Mills Estates
      </a>

      <nav className="site__nav">
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/mls">Listings</a>
        <a href="/styleguide">Style</a>
        {account}
      </nav>
    </header>
  );
}

/**
 * The page's main landmark — wraps the primary content below the header.
 *
 * A single `<main>` per page is what assistive tech jumps to with "skip to main
 * content"; without it Lighthouse flags "no main landmark". The `<header>` stays
 * its sibling, deliberately outside `<main>`.
 */
export function Main({ children }: { children: ReactNode }): ReactNode {
  return <main className="main">{children}</main>;
}

/** A page's headline and subhead. */
export function Hero({ heading, sub }: { heading: string; sub: string }): ReactNode {
  return (
    <section className="hero">
      <h1>{heading}</h1>

      <p>{sub}</p>
    </section>
  );
}

/** A paragraph of body copy. */
export function Copy({ text }: { text: string }): ReactNode {
  return <p className="copy">{text}</p>;
}

// --- design-system primitives (showcased on /styleguide) ---

/** A call-to-action: a link styled as a button (solid by default, or `ghost`). */
export function Button({
  href,
  variant,
  children,
}: {
  href?: string;
  variant?: "solid" | "ghost";
  children: ReactNode;
}): ReactNode {
  const className = variant === "ghost" ? "button button--ghost" : "button";

  return href === undefined ? (
    <button className={className} type="button">
      {children}
    </button>
  ) : (
    <a className={className} href={href}>
      {children}
    </a>
  );
}

/** A small rounded label — a status or category chip. */
export function Badge({ children }: { children: ReactNode }): ReactNode {
  return <span className="badge">{children}</span>;
}

/** A titled section block — the unit the style guide and lab pages are built from. */
export function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="section">
      <h2>{title}</h2>

      {children}
    </section>
  );
}

/** A color swatch with its name — a design-token chip for the style guide. */
export function Swatch({ color, name }: { color: string; name: string }): ReactNode {
  return (
    <span>
      <span className="swatch" style={{ background: color }} /> {name}
    </span>
  );
}

/** One listing: title, neighborhood, price, and size. */
export function ListingCard({
  title,
  neighborhood,
  price,
  beds,
  baths,
}: {
  title: string;
  neighborhood: string;
  price: string;
  beds: number;
  baths: number;
}): ReactNode {
  return (
    <article className="card">
      {/* h2, not h3: the page's only h1 is the Hero, so cards descend to h2 —
          skipping to h3 is what trips Lighthouse's sequential-heading audit. */}
      <h2>{title}</h2>

      <p className="card__where">{neighborhood}</p>

      <p className="card__price">{price}</p>

      <p className="card__size">
        {beds} bd · {baths} ba
      </p>
    </article>
  );
}

/** A grid over every listing, prices formatted for display. */
export function ListingGrid(): ReactNode {
  return (
    <section className="grid">
      {LISTINGS.map((listing) => (
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

/** What the `/mls` auth control renders from. */
export interface SignInPanelProps {
  signedIn: boolean;
  name?: string;
  /** Demo affordance — pre-fills the email/password so one click signs you in. */
  demoEmail?: string;
  demoPassword?: string;
}

/**
 * The `/mls` auth control: a sign-in form, or a greeting + sign-out.
 *
 * No CSRF token field: the `originCheck` middleware verifies the request's origin
 * from `Sec-Fetch-Site`, so a plain same-origin form post is enough (ADR 0005).
 */
export function SignInPanel({
  signedIn,
  name,
  demoEmail,
  demoPassword,
}: SignInPanelProps): ReactNode {
  if (signedIn) {
    return (
      <form className="auth" method="post" action="/mls/api/sign-out">
        <span>Signed in as {name}</span> <button type="submit">Sign out</button>
      </form>
    );
  }

  return (
    <form className="auth" method="post" action="/mls/api/sign-in">
      <label>
        Email
        <input
          type="email"
          name="email"
          defaultValue={demoEmail ?? ""}
          autoComplete="username"
          required
        />
      </label>

      <label>
        Password
        <input
          type="password"
          name="password"
          defaultValue={demoPassword ?? ""}
          autoComplete="current-password"
          required
        />
      </label>

      <button type="submit">Sign in</button>
    </form>
  );
}
