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
 * `buildEdgeApp(secret)` returns a plain `Application` whose `handle` is the pure
 * function the Worker fronts — so the same app is exercised by an in-process
 * E2E test and by the deployed Worker, with no divergence.
 */

import { Application, Controller } from "@keel/web";
import type { ControllerClass, KeelResponse } from "@keel/web";
import { Router } from "@keel/router";
import { SignedSessions } from "@keel/auth";
import { island } from "@keel/ui";
import type { UiNode } from "@keel/ui";

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

/**
 * Build the edge app over a signing secret.
 *
 * The secret backs every signed session; in the Worker it comes from
 * `env.SESSION_SECRET`, never the source.
 */
export function buildEdgeApp(secret: string): Application {
  const sessions = new SignedSessions({ secret });

  /** The user named by the request's session cookie, or undefined. */
  const currentUser = (cookieHeader: string | undefined): User | undefined => {
    const token = readCookie(cookieHeader, SESSION_COOKIE);

    if (token === undefined) return undefined;

    const claim = sessions.verify(token);

    return claim === undefined ? undefined : USERS.get(claim.userId);
  };

  class MarketingController extends Controller {
    home(): KeelResponse {
      const tree: UiNode = {
        type: "Page",
        children: [
          { type: "SiteHeader", children: [island("Account")] },
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
  }

  class MlsController extends Controller {
    /** The MLS landing page: the listings, with a sign-in/out control reflecting the session. */
    index(): KeelResponse {
      const user = currentUser(this.request.headers["cookie"]);

      const tree: UiNode = {
        type: "Page",
        children: [
          {
            type: "SiteHeader",
            // SignInPanel's `csrf` is required by its schema; the edge app does
            // not run CSRF (signed cookies + SameSite=Lax are the control here),
            // so the field is present but unused.
            children: [
              {
                type: "SignInPanel",
                props: { signedIn: user !== undefined, csrf: "", ...(user && { name: user.name }) },
              },
            ],
          },
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
        ],
      };

      return this.html(renderDocument(registry, tree, "MLS · Jade Mills Estates"));
    }

    /** The same-origin endpoint the marketing Account island calls. */
    session(): KeelResponse {
      const user = currentUser(this.request.headers["cookie"]);

      return user === undefined ? this.json({ user: null }, 401) : this.json({ user });
    }

    /** Demo sign-in: mint a SIGNED token for `?as=<id>` (default jade), set the cookie. */
    signIn(): KeelResponse {
      const user = USERS.get(this.request.query["as"] ?? "jade");

      if (user === undefined) return this.json({ error: "unknown user" }, 400);

      const token = sessions.issue(user.id, ONE_DAY_MS);

      return {
        status: 303,
        headers: {
          Location: "/mls",
          "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        },
        body: "",
      };
    }

    /** Sign out: clear the cookie. A signed token cannot be revoked, so it just expires. */
    signOut(): KeelResponse {
      return {
        status: 303,
        headers: {
          Location: "/mls",
          "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        },
        body: "",
      };
    }

    /** A gated resource: only a signed-in user's saved listings. */
    saved(): KeelResponse {
      const user = currentUser(this.request.headers["cookie"]);

      if (user === undefined) return this.json({ error: "sign in required" }, 401);

      return this.json({ user, saved: LISTINGS.slice(0, 2) });
    }
  }

  const router = new Router()
    .get("/", "marketing#home")
    .get("/mls", "mls#index")
    .get("/mls/api/session", "mls#session")
    .post("/mls/api/sign-in", "mls#signIn")
    .post("/mls/api/sign-out", "mls#signOut")
    .get("/mls/saved", "mls#saved");

  return new Application({
    router,
    controllers: {
      marketing: MarketingController as ControllerClass,
      mls: MlsController as ControllerClass,
    },
  });
}

/** The signing secret from the environment, with a loud demo fallback. */
export function edgeSecret(env?: { SESSION_SECRET?: string }): string {
  return env?.SESSION_SECRET ?? process.env["SESSION_SECRET"] ?? "estate-demo-edge-secret";
}
