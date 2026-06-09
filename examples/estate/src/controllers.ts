/**
 * The two zones' controllers.
 *
 *   MarketingController — the static `/` zone. Its pages prerender to HTML and
 *   carry the `Account` island, so they are cacheable yet auth-aware.
 *
 *   MlsController — the dynamic `/mls` zone. It owns the session: it mints the
 *   cookie on sign-in, answers `/mls/api/session` with the current user (what
 *   the marketing island calls), and gates `/mls/saved`.
 */

import { Controller } from "@keel/web";
import type { KeelResponse } from "@keel/web";
import { island } from "@keel/ui";
import type { UiNode } from "@keel/ui";

import { registry } from "./registry";
import { renderDocument } from "./document";
import { LISTINGS, formatPrice } from "./listings";
import {
  CSRF_FIELD,
  SESSION_COOKIE,
  clearCookie,
  csrfTokenForAnon,
  csrfTokenForSession,
  readCookie,
  sessionCookie,
  signIn,
  signOut,
  userForToken,
  verifyCsrfForAnon,
  verifyCsrfForSession,
} from "./auth";
import type { User } from "./auth";

/**
 * Demo-only impersonation: `?as=<id>` lets the sign-in form pick which seeded
 * user to become. It is an EXAMPLE affordance with no password — gated so it
 * can never ship to production. Enabled only outside production, or when
 * `KEEL_DEMO_AUTH` is explicitly set. Off by default in production.
 */
function demoImpersonationEnabled(): boolean {
  if (process.env["KEEL_DEMO_AUTH"] === "1") return true;

  return process.env["NODE_ENV"] !== "production";
}

/**
 * Pull a single field out of a urlencoded form body.
 *
 * The runtime hands a non-JSON body through as the raw string, so a form POST
 * arrives as `"_csrf=abc&as=jade"`. Returns `undefined` when the body is not a
 * string or the field is absent — callers treat that as "field not supplied".
 */
function formField(body: unknown, field: string): string | undefined {
  if (typeof body !== "string") return undefined;

  return new URLSearchParams(body).get(field) ?? undefined;
}

/** The site header, carrying the account control passed in (island or panel). */
function header(accountSlot: UiNode): UiNode {
  return { type: "SiteHeader", children: [accountSlot] };
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

export class MarketingController extends Controller {
  /** The static home page: hero + listings, with the auth-aware Account island. */
  home(): KeelResponse {
    const tree: UiNode = {
      type: "Page",
      children: [
        header(island("Account")),
        {
          type: "Hero",
          props: {
            heading: "Extraordinary homes, quietly sold.",
            sub: "Beverly Hills · Bel Air · Malibu",
          },
        },
        listingGrid(),
      ],
    };

    return this.html(renderDocument(registry, tree, "Jade Mills Estates"));
  }

  /** The static about page — also carries the island, also prerenders. */
  about(): KeelResponse {
    const tree: UiNode = {
      type: "Page",
      children: [
        header(island("Account")),
        {
          type: "Hero",
          props: { heading: "About Jade", sub: "Four decades at the top of luxury real estate." },
        },
        {
          type: "Copy",
          props: {
            text: "This marketing site is prerendered to static HTML and served from a CDN — yet the Account control still reflects who you are, resolved on the client against the same-origin /mls session.",
          },
        },
      ],
    };

    return this.html(renderDocument(registry, tree, "About · Jade Mills Estates"));
  }
}

export class MlsController extends Controller {
  /** The raw session token on the request, or `undefined` when none is set. */
  private sessionToken(): string | undefined {
    return readCookie(this.request.headers["cookie"], SESSION_COOKIE);
  }

  /** The current user, read from the session cookie on the request. */
  private currentUser(): User | undefined {
    return userForToken(this.sessionToken());
  }

  /** The dynamic MLS landing page: server-rendered, with a real sign-in form. */
  index(): KeelResponse {
    const token = this.sessionToken();
    const user = userForToken(token);

    // Mint the CSRF token for whichever form we render: bound to the session
    // for sign-out, or to the anon id for the signed-out sign-in form.
    const csrf =
      user !== undefined && token !== undefined ? csrfTokenForSession(token) : csrfTokenForAnon();

    const tree: UiNode = {
      type: "Page",
      children: [
        header({
          type: "SignInPanel",
          props: { signedIn: user !== undefined, csrf, ...(user && { name: user.name }) },
        }),
        {
          type: "Hero",
          props: {
            heading: user === undefined ? "MLS Search" : `Welcome back, ${user.name}`,
            sub:
              user === undefined
                ? "Sign in to save listings."
                : "Your saved searches are at /mls/saved.",
          },
        },
        listingGrid(),
      ],
    };

    return this.html(renderDocument(registry, tree, "MLS · Jade Mills Estates"));
  }

  /** The same-origin endpoint the marketing Account island calls. */
  session(): KeelResponse {
    const user = this.currentUser();

    if (user === undefined) return this.json({ user: null }, 401);

    return this.json({ user });
  }

  /**
   * Demo sign-in: mint a session and set the cookie.
   *
   * CSRF-guarded: the POST must carry the anon-bound token the sign-in form
   * embedded, or it is rejected. The `?as=<id>` impersonation that picks which
   * seeded user to become is DEMO-ONLY and fenced off in production.
   */
  signIn(): KeelResponse {
    const token = formField(this.request.body, CSRF_FIELD);

    if (token === undefined || !verifyCsrfForAnon(token)) {
      return this.json({ error: "invalid CSRF token" }, 403);
    }

    // DEMO-ONLY: choose the seeded user to become. Ignored in production, where
    // the affordance is fenced off, so a real deploy always signs in as `jade`.
    const requestedId = this.request.query["as"];
    const userId = demoImpersonationEnabled() ? (requestedId ?? "jade") : "jade";

    const session = signIn(userId);

    return {
      status: 303,
      headers: { Location: "/mls", "Set-Cookie": sessionCookie(session.token) },
      body: "",
    };
  }

  /**
   * Sign out: revoke the session and clear the cookie.
   *
   * CSRF-guarded: the POST must carry the session-bound token the sign-out form
   * embedded. A forged cross-site POST cannot present a token that verifies
   * against this session, so it cannot silently sign the user out.
   */
  signOut(): KeelResponse {
    const sessionToken = this.sessionToken();
    const csrf = formField(this.request.body, CSRF_FIELD);

    if (
      sessionToken === undefined ||
      csrf === undefined ||
      !verifyCsrfForSession(csrf, sessionToken)
    ) {
      return this.json({ error: "invalid CSRF token" }, 403);
    }

    signOut(sessionToken);

    return {
      status: 303,
      headers: { Location: "/mls", "Set-Cookie": clearCookie() },
      body: "",
    };
  }

  /** A gated resource: only a signed-in user's saved listings. */
  saved(): KeelResponse {
    const user = this.currentUser();

    if (user === undefined) return this.json({ error: "sign in required" }, 401);

    return this.json({ user, saved: LISTINGS.slice(0, 2) });
  }
}
