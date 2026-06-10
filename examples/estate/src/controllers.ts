/**
 * The two zones' controllers — `MarketingController` for `/`, `MlsController`
 * for `/mls`. Built through a factory so each app instance closes over its own
 * {@link Identity} (no module-scoped DB handle).
 *
 *   MarketingController — the static `/` zone. Its pages prerender to HTML and
 *   carry the `Account` island, so they are cacheable yet auth-aware.
 *
 *   MlsController — the dynamic `/mls` zone. It owns the session: it mints the
 *   cookie on sign-in via `Identity.login`, answers `/mls/api/session` with
 *   the current user (what the marketing island calls), and gates `/mls/saved`.
 */

import { Controller } from "@keel/web";
import type { ControllerClass, KeelResponse } from "@keel/web";
import { island } from "@keel/ui";
import type { UiNode } from "@keel/ui";

import { clearSessionCookie, IdentityError, readSessionToken, sessionCookie } from "@keel/identity";
import type { Identity } from "@keel/identity";

import { registry } from "./registry";
import { renderDocument } from "./document";
import { LISTINGS, formatPrice } from "./listings";
import {
  CSRF_FIELD,
  csrfTokenForAnon,
  csrfTokenForSession,
  verifyCsrfForAnon,
  verifyCsrfForSession,
} from "./auth";
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

export function buildControllers(identity: Identity): {
  marketing: ControllerClass;
  mls: ControllerClass;
} {
  class MarketingController extends Controller {
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
        ],
      };

      return this.html(renderDocument(registry, tree, "About · Jade Mills Estates"));
    }
  }

  class MlsController extends Controller {
    /** The raw session token on the request, or `undefined` when none is set. */
    private sessionToken(): string | undefined {
      return readSessionToken(this.request.headers["cookie"]);
    }

    /** The current user (an Identity model), or undefined when signed out. */
    private currentUser(): { email: string } | undefined {
      const user = identity.currentUser(this.sessionToken());

      return user === undefined ? undefined : { email: user.email };
    }

    /** The dynamic MLS landing page: server-rendered, with a real sign-in form. */
    index(): KeelResponse {
      const token = this.sessionToken();
      const user = this.currentUser();

      // Mint the CSRF token for whichever form we render: bound to the session
      // for sign-out, or to the anon id for the signed-out sign-in form.
      const csrf =
        user !== undefined && token !== undefined ? csrfTokenForSession(token) : csrfTokenForAnon();

      const name = user === undefined ? undefined : displayNameFor(user.email);

      const tree: UiNode = {
        type: "Page",
        children: [
          header({
            type: "SignInPanel",
            props: {
              signedIn: user !== undefined,
              csrf,
              demoEmail: DEFAULT_DEMO.email,
              demoPassword: DEFAULT_DEMO.password,
              ...(name && { name }),
            },
          }),
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
        ],
      };

      return this.html(renderDocument(registry, tree, "MLS · Jade Mills Estates"));
    }

    /** The same-origin endpoint the marketing Account island calls. */
    session(): KeelResponse {
      const user = this.currentUser();

      if (user === undefined) return this.json({ user: null }, 401);

      return this.json({ user: sessionUser(user.email) });
    }

    /**
     * Sign in — runs the real `Identity.login` flow.
     *
     * The form POSTs `_csrf`, `email`, and `password`. CSRF is checked before
     * Identity is touched, so a forged cross-site POST never reaches the
     * credential path. Bad credentials surface as 401 — Identity throws
     * `IDENTITY_INVALID_CREDENTIALS` (or `IDENTITY_EMAIL_NOT_VERIFIED`, which
     * cannot happen for the demo's pre-verified seeds).
     */
    signIn(): KeelResponse {
      const csrf = formField(this.request.body, CSRF_FIELD);

      if (csrf === undefined || !verifyCsrfForAnon(csrf)) {
        return this.json({ error: "invalid CSRF token" }, 403);
      }

      const email = formField(this.request.body, "email") ?? "";
      const password = formField(this.request.body, "password") ?? "";

      try {
        const { session } = identity.login(email, password);

        return {
          status: 303,
          headers: { Location: "/mls", "Set-Cookie": sessionCookie(session.token) },
          body: "",
        };
      } catch (error) {
        if (error instanceof IdentityError) {
          return this.json({ error: "invalid credentials", code: error.code }, 401);
        }

        throw error;
      }
    }

    /**
     * Sign out: revoke the session and clear the cookie.
     *
     * CSRF-guarded: the POST must carry the session-bound token the sign-out
     * form embedded. A forged cross-site POST cannot present a token that
     * verifies against this session, so it cannot silently sign the user out.
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

      identity.logout(sessionToken);

      return {
        status: 303,
        headers: { Location: "/mls", "Set-Cookie": clearSessionCookie() },
        body: "",
      };
    }

    /** A gated resource: only a signed-in user's saved listings. */
    saved(): KeelResponse {
      const user = this.currentUser();

      if (user === undefined) return this.json({ error: "sign in required" }, 401);

      return this.json({ user: sessionUser(user.email), saved: LISTINGS.slice(0, 2) });
    }
  }

  return {
    marketing: MarketingController as ControllerClass,
    mls: MlsController as ControllerClass,
  };
}
