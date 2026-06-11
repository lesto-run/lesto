/**
 * The estate's routes for both zones, on one composable `keel()` app.
 *
 *   marketing (`/`, `/about`) — the static zone. Its pages prerender to HTML and
 *   carry the `Account` island, so they are cacheable yet auth-aware.
 *
 *   mls (`/mls/*`) — the dynamic zone. It owns the session: it mints the cookie
 *   on sign-in via `Identity.login`, answers `/mls/api/session` with the current
 *   user (what the marketing island calls), and gates `/mls/saved`.
 *
 * Built through a factory so the handlers close over their own {@link Identity}
 * (no module-scoped DB handle). The pages still render through the retained
 * `renderDocument`/`Registry`/island path (ADR 0004 reserves it for hand-authored
 * and DB-driven views alike) — only dispatch moved off the legacy
 * `Application`/`Controller`/`Router` onto `keel()`. Converting these to `.page`
 * waits on islands-through-pages (Phase 4); until then `renderDocument` keeps the
 * Account island hydrating exactly as before.
 */

import { keel } from "@keel/web";
import type { Context, Keel } from "@keel/web";
import { island } from "@keel/ui";
import type { UiNode } from "@keel/ui";

import { clearSessionCookie, IdentityError, readSessionToken, sessionCookie } from "@keel/identity";
import type { Identity } from "@keel/identity";

import { registry } from "./registry";
import { renderDocument } from "./document";
import { LISTINGS, formatPrice } from "./listings";
import { DEFAULT_DEMO, DEMO_ACCOUNTS } from "./identity";

/** What the client sees on `/mls/api/session` — the same shape the Account island consumes. */
interface SessionResponseUser {
  readonly id: string;
  readonly name: string;
}

/**
 * Pull a single field out of a urlencoded form body.
 *
 * The runtime hands a non-JSON body through as the raw string, so a form POST
 * arrives as `"_csrf=abc&email=x&password=y"`. Returns `undefined` when the
 * body is not a string or the field is absent — callers treat that as "not
 * supplied".
 */
function formField(body: unknown, field: string): string | undefined {
  if (typeof body !== "string") return undefined;

  return new URLSearchParams(body).get(field) ?? undefined;
}

/** The display name to surface for a signed-in user, mapped from their email. */
function displayNameFor(email: string): string {
  return DEMO_ACCOUNTS.find((d) => d.email === email)?.displayName ?? email;
}

/** Shape the user as the session endpoint and the island both expect. */
function sessionUser(email: string): SessionResponseUser {
  return { id: email, name: displayNameFor(email) };
}

/** The site header, carrying the account control passed in (island or panel). */
function header(accountSlot: UiNode): UiNode {
  return { type: "SiteHeader", children: [accountSlot] };
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

/** The estate app's routes, closing over the {@link Identity} they authenticate against. */
export function buildEstateRoutes(identity: Identity): Keel {
  /** The current user (an Identity model), or undefined when signed out. */
  const currentUser = async (c: Context): Promise<{ email: string } | undefined> => {
    const user = await identity.currentUser(readSessionToken(c.header("cookie")));

    return user === undefined ? undefined : { email: user.email };
  };

  return (
    keel()
      // --- marketing (static) zone ---
      // The static home page: hero + listings, with the auth-aware Account island.
      .get("/", (c) => {
        const tree: UiNode = {
          type: "Page",
          children: [
            header(island("Account")),
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
          ),
        );
      })
      // The static about page — also carries the island, also prerenders.
      .get("/about", (c) => {
        const tree: UiNode = {
          type: "Page",
          children: [
            header(island("Account")),
            main(
              {
                type: "Hero",
                props: {
                  heading: "About Jade",
                  sub: "Four decades at the top of luxury real estate.",
                },
              },
              {
                type: "Copy",
                props: {
                  text: "This marketing site is prerendered to static HTML and served from a CDN — yet the Account control still reflects who you are, resolved on the client against the same-origin /mls session.",
                },
              },
            ),
          ],
        };

        return c.html(
          renderDocument(
            registry,
            tree,
            "About · Jade Mills Estates",
            "Four decades at the top of luxury real estate — about Jade Mills and the Jade Mills Estates marketing site.",
          ),
        );
      })
      // --- mls (dynamic) zone ---
      // The dynamic MLS landing page: server-rendered, with a real sign-in form.
      .get("/mls", async (c) => {
        const user = await currentUser(c);

        const name = user === undefined ? undefined : displayNameFor(user.email);

        const tree: UiNode = {
          type: "Page",
          children: [
            header({
              type: "SignInPanel",
              props: {
                signedIn: user !== undefined,
                demoEmail: DEFAULT_DEMO.email,
                demoPassword: DEFAULT_DEMO.password,
                ...(name && { name }),
              },
            }),
            main(
              {
                type: "Hero",
                props: {
                  heading: user === undefined ? "MLS Search" : `Welcome back, ${name}`,
                  sub:
                    user === undefined
                      ? "Sign in to save listings."
                      : "Your saved searches are at /mls/saved.",
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
          ),
        );
      })
      /**
       * The same-origin endpoint the marketing Account island calls.
       *
       * This is an identity *probe*, not a gated resource: "nobody is signed in"
       * is a normal, expected answer, so it returns 200 with `{ user: null }`
       * rather than 401. A 401 here would be logged by the browser as a failed
       * resource load (a console error Lighthouse flags) on every signed-out view
       * of a public marketing page. The genuinely gated resources — `/mls/saved`,
       * and any state-changing POST — still answer 401/403.
       */
      .get("/mls/api/session", async (c) => {
        const user = await currentUser(c);

        if (user === undefined) return c.json({ user: null });

        return c.json({ user: sessionUser(user.email) });
      })
      /**
       * Sign in — runs the real `Identity.login` flow.
       *
       * CSRF is handled upstream by the `originCheck` middleware (`secureStack`):
       * a cross-site POST is refused with a 403 before dispatch ever reaches this
       * handler, so it only sees same-origin form posts. The form POSTs `email`
       * and `password`. Bad credentials surface as 401 — Identity throws
       * `IDENTITY_INVALID_CREDENTIALS` (or `IDENTITY_EMAIL_NOT_VERIFIED`, which
       * cannot happen for the demo's pre-verified seeds).
       */
      .post("/mls/api/sign-in", async (c) => {
        const email = formField(c.req.body, "email") ?? "";
        const password = formField(c.req.body, "password") ?? "";

        try {
          const { session } = await identity.login(email, password);

          return {
            status: 303,
            headers: { Location: "/mls", "Set-Cookie": sessionCookie(session.token) },
            body: "",
          };
        } catch (error) {
          if (error instanceof IdentityError) {
            return c.json({ error: "invalid credentials", code: error.code }, 401);
          }

          throw error;
        }
      })
      /**
       * Sign out: revoke the session and clear the cookie.
       *
       * The `originCheck` middleware refuses a cross-site POST before it arrives,
       * so a forgery cannot reach here to silently sign the user out. Revoking is
       * idempotent — a request without a session token just clears the cookie.
       */
      .post("/mls/api/sign-out", (c) => {
        const sessionToken = readSessionToken(c.header("cookie"));

        if (sessionToken !== undefined) identity.logout(sessionToken);

        return {
          status: 303,
          headers: { Location: "/mls", "Set-Cookie": clearSessionCookie() },
          body: "",
        };
      })
      // A gated resource: only a signed-in user's saved listings.
      .get("/mls/saved", async (c) => {
        const user = await currentUser(c);

        if (user === undefined) return c.json({ error: "sign in required" }, 401);

        return c.json({ user: sessionUser(user.email), saved: LISTINGS.slice(0, 2) });
      })
  );
}
