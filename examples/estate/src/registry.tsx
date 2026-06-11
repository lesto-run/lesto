/**
 * The estate site's component vocabulary — server components plus one island.
 *
 * Everything here renders on the server (so the marketing pages prerender to
 * static HTML) EXCEPT `Account`, declared with `defineClient`: it is an island,
 * rendered on the server as its `fallback` shell and hydrated per-user on the
 * client. The same registry serves both zones and is imported by the browser
 * entry, so the client mounts the very component the server reserved a slot for.
 */

import { Registry } from "@keel/ui";

import { Account, AccountFallback } from "./account";
import { sessionSource } from "./session-source";

export const registry = new Registry()
  .define({
    name: "Page",
    description: "The outermost shell wrapping a page's sections.",
    props: {},
    children: true,
    render: (_props, children) => <div className="estate">{children}</div>,
  })
  .define({
    name: "SiteHeader",
    description: "The top bar: brand, nav, and the account slot (an island).",
    props: {},
    children: true,
    render: (_props, children) => (
      <header className="site">
        <a className="site__brand" href="/">
          Jade Mills Estates
        </a>

        <nav className="site__nav">
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/mls">Listings</a>
          {children}
        </nav>
      </header>
    ),
  })
  .define({
    name: "Main",
    description: "The page's main landmark — wraps the primary content below the header.",
    props: {},
    children: true,
    // A single <main> landmark per page is what assistive tech jumps to with
    // "skip to main content"; without it Lighthouse flags "no main landmark".
    // The <header> stays its sibling, deliberately outside <main>.
    render: (_props, children) => <main className="main">{children}</main>,
  })
  .define({
    name: "Hero",
    description: "A page's headline and subhead.",
    props: {
      heading: { type: "string", required: true },
      sub: { type: "string", required: true },
    },
    children: false,
    render: (props) => (
      <section className="hero">
        <h1>{String(props["heading"])}</h1>

        <p>{String(props["sub"])}</p>
      </section>
    ),
  })
  .define({
    name: "Copy",
    description: "A paragraph of body copy.",
    props: {
      text: { type: "string", required: true },
    },
    children: false,
    render: (props) => <p className="copy">{String(props["text"])}</p>,
  })
  .define({
    name: "ListingGrid",
    description: "A grid of listing cards.",
    props: {},
    children: ["ListingCard"],
    render: (_props, children) => <section className="grid">{children}</section>,
  })
  .define({
    name: "ListingCard",
    description: "One listing: title, neighborhood, price, and size.",
    props: {
      title: { type: "string", required: true },
      neighborhood: { type: "string", required: true },
      price: { type: "string", required: true },
      beds: { type: "number", required: true },
      baths: { type: "number", required: true },
    },
    children: false,
    render: (props) => (
      <article className="card">
        {/* h2, not h3: the page's only h1 is the Hero, so cards descend to h2 —
            skipping to h3 is what trips Lighthouse's sequential-heading audit. */}
        <h2>{String(props["title"])}</h2>

        <p className="card__where">{String(props["neighborhood"])}</p>

        <p className="card__price">{String(props["price"])}</p>

        <p className="card__size">
          {String(props["beds"])} bd · {String(props["baths"])} ba
        </p>
      </article>
    ),
  })
  .define({
    name: "SignInPanel",
    description: "The /mls auth control: a sign-in form, or a greeting + sign-out.",
    props: {
      signedIn: { type: "boolean", required: true },
      name: { type: "string" },
      // Demo affordance — pre-fills the email and password so one click signs
      // you in. The POST still goes through real `Identity.login`; the demo
      // is in the *value* of the field, not in the path it travels.
      demoEmail: { type: "string" },
      demoPassword: { type: "string" },
    },
    children: false,
    // No CSRF token field: the `originCheck` middleware verifies the request's
    // origin from `Sec-Fetch-Site`, so a plain same-origin form post is enough.
    render: (props) =>
      props["signedIn"] === true ? (
        <form className="auth" method="post" action="/mls/api/sign-out">
          <span>Signed in as {String(props["name"])}</span> <button type="submit">Sign out</button>
        </form>
      ) : (
        <form className="auth" method="post" action="/mls/api/sign-in">
          <label>
            Email
            <input
              type="email"
              name="email"
              defaultValue={String(props["demoEmail"] ?? "")}
              autoComplete="username"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              name="password"
              defaultValue={String(props["demoPassword"] ?? "")}
              autoComplete="current-password"
              required
            />
          </label>

          <button type="submit">Sign in</button>
        </form>
      ),
  })
  .defineClient({
    name: "Account",
    description: "The signed-in/out account control — resolved per-user from the session source.",
    // Eager ON PURPOSE — do not "optimize" this into a lazy `load:`. Account is
    // ~1 KB, above the fold, and always mounts, so code-splitting it defers
    // nothing and only adds request hops (the measured Lighthouse critical
    // chain). Split when an island's bytes are HEAVY or its mount is
    // CONDITIONAL — neither is true here. The `load:` capability + its proof
    // live in @keel/ui's unit tests; see ADR 0009 for when to reach for it.
    component: Account,
    fallback: AccountFallback,
    // Its `session` prop is resolved from the session source (ADR 0010): primed
    // at HTML-parse time on the static marketing page, parallel with client.js —
    // no `fetch`-in-effect, no waterfall. The server binds the impl in
    // controllers.ts (node) and edge.ts (worker).
    data: { session: sessionSource },
  });
