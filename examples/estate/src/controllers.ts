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

      return this.html(
        renderDocument(
          registry,
          tree,
          "Jade Mills Estates",
          "Extraordinary homes, quietly sold across Beverly Hills, Bel Air, and Malibu — browse Jade Mills' luxury listings.",
        ),
      );
    }

    /** The static about page — also carries the island, also prerenders. */
    about(): KeelResponse {
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

      return this.html(
        renderDocument(
          registry,
          tree,
          "About · Jade Mills Estates",
          "Four decades at the top of luxury real estate — about Jade Mills and the Jade Mills Estates marketing site.",
        ),
      );
    }
  }

  class MlsController extends Controller {
    /** The raw session token on the request, or `undefined` when none is set. */
    private sessionToken(): string | undefined {
      return readSessionToken(this.request.headers["cookie"]);
    }

    /** The current user (an Identity model), or undefined when signed out. */
    private async currentUser(): Promise<{ email: string } | undefined> {
      const user = await identity.currentUser(this.sessionToken());

      return user === undefined ? undefined : { email: user.email };
    }

    /** The dynamic MLS landing page: server-rendered, with a real sign-in form. */
    async index(): Promise<KeelResponse> {
      const user = await this.currentUser();

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

      return this.html(
        renderDocument(
          registry,
          tree,
          "MLS · Jade Mills Estates",
          "Search the Jade Mills MLS and sign in to save listings.",
        ),
      );
    }

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
    async session(): Promise<KeelResponse> {
      const user = await this.currentUser();

      if (user === undefined) return this.json({ user: null });

      return this.json({ user: sessionUser(user.email) });
    }

    /**
     * Sign in — runs the real `Identity.login` flow.
     *
     * CSRF is handled upstream by the `originCheck` middleware (`secureStack`):
     * a cross-site POST is refused with a 403 before dispatch ever reaches this
     * action, so the handler only sees same-origin form posts. The form POSTs
     * `email` and `password`. Bad credentials surface as 401 — Identity throws
     * `IDENTITY_INVALID_CREDENTIALS` (or `IDENTITY_EMAIL_NOT_VERIFIED`, which
     * cannot happen for the demo's pre-verified seeds).
     */
    async signIn(): Promise<KeelResponse> {
      const email = formField(this.request.body, "email") ?? "";
      const password = formField(this.request.body, "password") ?? "";

      try {
        const { session } = await identity.login(email, password);

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
     * The `originCheck` middleware refuses a cross-site POST before it arrives,
     * so a forgery cannot reach here to silently sign the user out. Revoking is
     * idempotent — a request without a session token just clears the cookie.
     */
    signOut(): KeelResponse {
      const sessionToken = this.sessionToken();

      if (sessionToken !== undefined) identity.logout(sessionToken);

      return {
        status: 303,
        headers: { Location: "/mls", "Set-Cookie": clearSessionCookie() },
        body: "",
      };
    }

    /** A gated resource: only a signed-in user's saved listings. */
    async saved(): Promise<KeelResponse> {
      const user = await this.currentUser();

      if (user === undefined) return this.json({ error: "sign in required" }, 401);

      return this.json({ user: sessionUser(user.email), saved: LISTINGS.slice(0, 2) });
    }
  }

  return {
    marketing: MarketingController as ControllerClass,
    mls: MlsController as ControllerClass,
  };
}
