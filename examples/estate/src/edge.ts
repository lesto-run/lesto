/**
 * The estate app, wired for the edge.
 *
 * Same site, same registry, same pages — but the session is a **stateless signed
 * token** (`@keel/auth`'s `SignedSessions`), not a row in an in-memory store.
 * That is the one change a Cloudflare Worker demands: an isolate is ephemeral
 * and per-PoP, so a store is empty on the next request; a signed token carries
 * its own proof and verifies anywhere the secret is known. The node demo
 * (`serve.ts`) keeps using the store-backed `Sessions`; this is the edge twin.
 *
 * `buildEdgeApp(secret)` returns a composable `keel()` app whose `handle` is the
 * pure function the Worker fronts — so the same app is exercised by an in-process
 * E2E test and by the deployed Worker, with no divergence. Pages still render
 * through the retained `renderDocument`/island path; only dispatch moved off the
 * legacy `Application`/`Controller`/`Router` onto `keel()`.
 */

import { keel } from "@keel/web";
import type { Keel } from "@keel/web";
import { SignedSessions } from "@keel/auth";
import { island } from "@keel/ui";
import type { ServerRenderer, UiNode } from "@keel/ui";

import { registry } from "./registry";
import { renderDocument } from "./document";
import { LISTINGS, formatPrice } from "./listings";

/** A signed-in person. */
export interface User {
  readonly id: string;
  readonly name: string;
}

/** The demo's users, by id. A real app looks these up in its database. */
const USERS = new Map<string, User>([
  ["jade", { id: "jade", name: "Jade Mills" }],
  ["guest", { id: "guest", name: "Guest Buyer" }],
]);

/** The session cookie — `__Host-` so the browser enforces Secure + Path=/ + no Domain. */
const SESSION_COOKIE = "__Host-keel_session";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Read one cookie's value out of a `Cookie` header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");

    if (key === name) return rest.join("=");
  }

  return undefined;
}

/** The page's `<main>` landmark, wrapping the primary content below the header. */
function main(...children: UiNode[]): UiNode {
  return { type: "Main", children };
}

/** A grid node over every listing, prices formatted for display. */
function listingGrid(): UiNode {
  return {
    type: "ListingGrid",
    children: LISTINGS.map((listing) => ({
      type: "ListingCard",
      props: {
        title: listing.title,
        neighborhood: listing.neighborhood,
        price: formatPrice(listing.price),
        beds: listing.beds,
        baths: listing.baths,
      },
    })),
  };
}

/** What `buildEdgeApp` accepts beyond the signing secret. */
export interface EdgeAppOptions {
  /**
   * The server-render dialect the pages use — default React. The Worker passes
   * `preactServerRenderer` because its bundle is aliased to `preact/compat`
   * (`wrangler.jsonc`), so the SSR'd markup matches the Preact client bundle the
   * deploy ships (ADR 0008's matched pair). The in-process tests, which run this
   * file unaliased, leave it unset and render React.
   */
  readonly serverRenderer?: ServerRenderer;
}

/**
 * Build the edge app over a signing secret.
 *
 * The secret backs every signed session; in the Worker it comes from
 * `env.SESSION_SECRET`, never the source.
 */
export function buildEdgeApp(secret: string, options: EdgeAppOptions = {}): Keel {
  const sessions = new SignedSessions({ secret });

  const renderer = options.serverRenderer;

  /** The user named by the request's session cookie, or undefined. */
  const currentUser = (cookieHeader: string | undefined): User | undefined => {
    const token = readCookie(cookieHeader, SESSION_COOKIE);

    if (token === undefined) return undefined;

    const claim = sessions.verify(token);

    return claim === undefined ? undefined : USERS.get(claim.userId);
  };

  return (
    keel()
      .get("/", (c) => {
        const tree: UiNode = {
          type: "Page",
          children: [
            { type: "SiteHeader", children: [island("Account")] },
            main(
              {
                type: "Hero",
                props: {
                  heading: "Extraordinary homes, quietly sold.",
                  sub: "Beverly Hills · Bel Air · Malibu",
                },
              },
              listingGrid(),
            ),
          ],
        };

        return c.html(
          renderDocument(
            registry,
            tree,
            "Jade Mills Estates",
            "Extraordinary homes, quietly sold across Beverly Hills, Bel Air, and Malibu — browse Jade Mills' luxury listings.",
            renderer,
          ),
        );
      })
      // The MLS landing page: the listings, with a sign-in/out control reflecting the session.
      .get("/mls", (c) => {
        const user = currentUser(c.header("cookie"));

        const tree: UiNode = {
          type: "Page",
          children: [
            {
              type: "SiteHeader",
              // The edge app's CSRF control is the signed cookie + SameSite=Lax,
              // not a form token — so SignInPanel renders without one.
              children: [
                {
                  type: "SignInPanel",
                  props: { signedIn: user !== undefined, ...(user && { name: user.name }) },
                },
              ],
            },
            main(
              {
                type: "Hero",
                props: {
                  heading: user === undefined ? "MLS Search" : `Welcome back, ${user.name}`,
                  sub:
                    user === undefined
                      ? "Sign in to save listings."
                      : "Your saved listings are at /mls/saved.",
                },
              },
              listingGrid(),
            ),
          ],
        };

        return c.html(
          renderDocument(
            registry,
            tree,
            "MLS · Jade Mills Estates",
            "Search the Jade Mills MLS and sign in to save listings.",
            renderer,
          ),
        );
      })
      /**
       * The same-origin endpoint the marketing Account island calls.
       *
       * An identity *probe*, not a gated resource: "nobody is signed in" is a
       * normal answer, so it returns 200 with `{ user: null }`. A 401 here would
       * be logged by the browser as a failed resource load — a console error
       * Lighthouse flags — on every signed-out view of the public marketing page,
       * whose island fetches this on load. The gated `/mls/saved` still 401s.
       */
      .get("/mls/api/session", (c) => {
        const user = currentUser(c.header("cookie"));

        return user === undefined ? c.json({ user: null }) : c.json({ user });
      })
      // Demo sign-in: mint a SIGNED token for `?as=<id>` (default jade), set the cookie.
      .post("/mls/api/sign-in", (c) => {
        const user = USERS.get(c.query("as") ?? "jade");

        if (user === undefined) return c.json({ error: "unknown user" }, 400);

        const token = sessions.issue(user.id, ONE_DAY_MS);

        return {
          status: 303,
          headers: {
            Location: "/mls",
            "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          },
          body: "",
        };
      })
      // Sign out: clear the cookie. A signed token cannot be revoked, so it just expires.
      .post("/mls/api/sign-out", () => ({
        status: 303,
        headers: {
          Location: "/mls",
          "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        },
        body: "",
      }))
      // A gated resource: only a signed-in user's saved listings.
      .get("/mls/saved", (c) => {
        const user = currentUser(c.header("cookie"));

        if (user === undefined) return c.json({ error: "sign in required" }, 401);

        return c.json({ user, saved: LISTINGS.slice(0, 2) });
      })
  );
}

/** The signing secret from the environment, with a loud demo fallback. */
export function edgeSecret(env?: { SESSION_SECRET?: string }): string {
  return env?.SESSION_SECRET ?? process.env["SESSION_SECRET"] ?? "estate-demo-edge-secret";
}
