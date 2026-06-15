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

import { fromRequestMiddleware, keel } from "@keel/web";
import type { Keel } from "@keel/web";
import { SignedSessions } from "@keel/auth";
import { secureStack } from "@keel/kernel";
import { clearSessionCookie, readSessionToken, sessionCookie } from "@keel/identity";
import { island } from "@keel/ui";
import type { UiNode } from "@keel/ui";
import type { ServerRenderer } from "@keel/ui/server";

import { registry } from "./registry";
import { sessionSource } from "./session-source";
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

// The session cookie name and serializers live in `@keel/identity`'s cookie
// module — the single source of the `__Host-` discipline. The edge twin reuses
// them rather than re-deriving the contract (it used to keep its own copy).

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// The edge isolate's per-client rate-limit policy: a small burst, refilled
// steadily. Keyed by the request-context client IP (`cf-connecting-ip`, set by
// Cloudflare and not client-forgeable), so a flood from one client is shed
// before it reaches dispatch. Built once per `buildEdgeApp` call (per isolate),
// which is the lifetime a token bucket must outlive.
const EDGE_RATE_LIMIT = { capacity: 60, refillPerSecond: 10 } as const;

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

  /**
   * Whether the passwordless `?as=<id>` demo sign-in is reachable.
   *
   * The edge twin's sign-in mints a session for a user id with NO credential
   * check — fine for the public demo, a wide-open auth bypass for a real deploy.
   * It is therefore OFF by default and turned on only under an explicit demo
   * binding (`KEEL_DEMO=1`, resolved by {@link isDemoMode}). With it off, the
   * sign-in route is registered but refuses (403), so a forgotten flag fails
   * closed rather than silently exposing impersonation.
   */
  readonly demo?: boolean;
}

/**
 * Build the edge app over a signing secret.
 *
 * The secret backs every signed session; in the Worker it comes from
 * `env.SESSION_SECRET`, never the source. The app mounts the framework's
 * `secureStack` (origin-check CSRF + per-isolate rate limiting) ahead of every
 * route, so a cross-site state-changing request is refused before dispatch and a
 * flood is shed early. This is the node twin's (`app.ts`) origin-check posture
 * PLUS per-isolate rate limiting the edge adds on top — `app.ts` runs no rate
 * limiter (a single long-lived node process leans on infra for that; a
 * short-lived Worker isolate cannot, so the edge sheds floods itself).
 */
export function buildEdgeApp(secret: string, options: EdgeAppOptions = {}): Keel {
  const sessions = new SignedSessions({ secret });

  const renderer = options.serverRenderer;
  const demo = options.demo ?? false;

  /** The user named by the request's session cookie, or undefined. */
  const currentUser = (cookieHeader: string | undefined): User | undefined => {
    const token = readSessionToken(cookieHeader);

    if (token === undefined) return undefined;

    const claim = sessions.verify(token);

    return claim === undefined ? undefined : USERS.get(claim.userId);
  };

  return (
    keel()
      // The node twin's origin-check CSRF posture, PLUS per-isolate rate limiting
      // the edge adds on top (app.ts has none) — both wrap every route (and every
      // 404), applied before any route so a forged cross-site POST or a flood is
      // refused ahead of dispatch.
      .use(
        ...secureStack({ originCheck: {}, rateLimit: EDGE_RATE_LIMIT }).map(fromRequestMiddleware),
      )
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
       * The session data source the marketing Account island binds to (ADR 0010).
       *
       * Auto-exposed at `/__keel/data/session`; the framework delivers its value
       * to the island as a prop (primed parallel with client.js), replacing the
       * old `/mls/api/session` route + client fetch. An identity *probe*, not a
       * gated resource — "nobody is signed in" is a normal `null`/200, never a
       * 401. The signed-token user is already the `{ id, name }` DTO. The gated
       * `/mls/saved` still 401s.
       */
      .data(sessionSource, (c) => currentUser(c.header("cookie")) ?? null)
      // Demo sign-in: mint a SIGNED token for `?as=<id>` (default jade), set the
      // cookie. PASSWORDLESS by design — it impersonates a user id with no
      // credential check — so it is fenced behind the demo flag: off, every
      // request to it is refused (403), never a silent auth bypass. A real deploy
      // wires `@keel/identity` (the node twin in `app.ts` already does).
      .post("/mls/api/sign-in", (c) => {
        if (!demo) {
          return c.json({ error: "sign-in is disabled outside demo mode" }, 403);
        }

        const user = USERS.get(c.query("as") ?? "jade");

        if (user === undefined) return c.json({ error: "unknown user" }, 400);

        const token = sessions.issue(user.id, ONE_DAY_MS);

        return {
          status: 303,
          headers: { Location: "/mls", "Set-Cookie": sessionCookie(token) },
          body: "",
        };
      })
      // Sign out: clear the cookie. A signed token cannot be revoked, so it just expires.
      .post("/mls/api/sign-out", () => ({
        status: 303,
        headers: { Location: "/mls", "Set-Cookie": clearSessionCookie() },
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

/**
 * The committed demo signing secret — used ONLY in demo mode.
 *
 * >= 32 bytes so the secret-strength guard (`SignedSessions`) accepts it. It is
 * public by design (it is in the source); a real deploy never reaches it because
 * it is gated behind {@link isDemoMode}.
 */
const DEMO_EDGE_SECRET = "estate-demo-edge-secret-0123456789ab";

/** The environment bindings the edge entry reads. */
export interface EdgeEnv {
  readonly SESSION_SECRET?: string;
  readonly KEEL_DEMO?: string;
}

/**
 * Is the Worker running in demo mode?
 *
 * Demo mode is the OPT-IN escape hatch that allows the committed fallback secret
 * and the passwordless `?as=` sign-in. It requires an explicit `KEEL_DEMO=1`
 * binding (from the Worker `env` or `process.env`) — anything else, including an
 * absent binding, is NOT demo mode. The framework's pattern for every
 * secret-bearing Worker: production is the default, demo is the loud opt-in.
 */
export function isDemoMode(env?: EdgeEnv): boolean {
  return (env?.KEEL_DEMO ?? process.env["KEEL_DEMO"]) === "1";
}

/**
 * The signing secret from the environment — FAIL CLOSED.
 *
 * In production (`isDemoMode` false) an absent `SESSION_SECRET` THROWS rather
 * than falling back to a committed literal: a Worker with no trust root must not
 * serve a single request signing sessions anyone can forge. The committed
 * {@link DEMO_EDGE_SECRET} is reachable ONLY under an explicit `KEEL_DEMO=1`
 * binding. This is the framework's pattern for every secret-bearing Worker.
 */
export function edgeSecret(env?: EdgeEnv): string {
  const secret = env?.SESSION_SECRET ?? process.env["SESSION_SECRET"];

  if (secret !== undefined) return secret;

  if (isDemoMode(env)) return DEMO_EDGE_SECRET;

  throw new Error(
    "SESSION_SECRET is not set and KEEL_DEMO is not enabled. Refusing to serve: set the " +
      "SESSION_SECRET wrangler secret (`wrangler secret put SESSION_SECRET`), or set KEEL_DEMO=1 " +
      "to run the public demo with its committed fallback secret.",
  );
}
