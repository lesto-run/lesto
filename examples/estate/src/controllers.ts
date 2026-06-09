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
  SESSION_COOKIE,
  clearCookie,
  readCookie,
  sessionCookie,
  signIn,
  signOut,
  userForToken,
} from "./auth";
import type { User } from "./auth";

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
  /** The current user, read from the session cookie on the request. */
  private currentUser(): User | undefined {
    const token = readCookie(this.request.headers["cookie"], SESSION_COOKIE);

    return userForToken(token);
  }

  /** The dynamic MLS landing page: server-rendered, with a real sign-in form. */
  index(): KeelResponse {
    const user = this.currentUser();

    const tree: UiNode = {
      type: "Page",
      children: [
        header({
          type: "SignInPanel",
          props: { signedIn: user !== undefined, ...(user && { name: user.name }) },
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

  /** Demo sign-in: mint a session for `?as=<id>` (default jade) and set the cookie. */
  signIn(): KeelResponse {
    const session = signIn(this.request.query["as"] ?? "jade");

    return {
      status: 303,
      headers: { Location: "/mls", "Set-Cookie": sessionCookie(session.token) },
      body: "",
    };
  }

  /** Sign out: revoke the session and clear the cookie. */
  signOut(): KeelResponse {
    signOut(readCookie(this.request.headers["cookie"], SESSION_COOKIE));

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
