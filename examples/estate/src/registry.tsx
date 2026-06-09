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
        <h3>{String(props["title"])}</h3>

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
      // The CSRF token for this form's POST, minted server-side and bound to
      // the session (sign-out) or the anon id (sign-in). Verified on submit.
      csrf: { type: "string", required: true },
    },
    children: false,
    render: (props) =>
      props["signedIn"] === true ? (
        <form className="auth" method="post" action="/mls/api/sign-out">
          <input type="hidden" name="_csrf" value={String(props["csrf"])} />
          <span>Signed in as {String(props["name"])}</span> <button type="submit">Sign out</button>
        </form>
      ) : (
        <form className="auth" method="post" action="/mls/api/sign-in">
          <input type="hidden" name="_csrf" value={String(props["csrf"])} />
          <button type="submit">Sign in (demo)</button>
        </form>
      ),
  })
  .defineClient({
    name: "Account",
    description: "The signed-in/out account control — resolved per-user on the client.",
    component: Account,
    fallback: AccountFallback,
  });
