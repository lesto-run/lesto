/**
 * The estate app, wired for the edge.
 *
 * Same site, same pages — but the session is a **stateless signed token**
 * (`@lesto/auth`'s `SignedSessions`), not a row in an in-memory store. That is the
 * one change a Cloudflare Worker demands: an isolate is ephemeral and per-PoP, so
 * a store is empty on the next request; a signed token carries its own proof and
 * verifies anywhere the secret is known. The node demo (`serve.ts`) keeps using
 * the store-backed identity; this is the edge twin.
 *
 * `buildEdgeApp(secret)` returns a composable `lesto()` app whose `handle` is the
 * pure function the Worker fronts — so the same app is exercised by an in-process
 * E2E test and by the deployed Worker, with no divergence. Pages are plain React
 * (`pages.tsx`) rendered by `.page`; the Worker passes `preactServerRenderer` so
 * the buffered SSR markup matches the Preact client bundle it ships (ADR 0008).
 */

import { fromRequestMiddleware, lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";
import { SignedSessions } from "@lesto/auth";
import { secureStack } from "@lesto/kernel";
import { clearSessionCookie, readSessionToken, sessionCookie } from "@lesto/identity";
import type { ServerRenderer } from "@lesto/ui/server";

import { sessionSource } from "./session-source";
import { EstateLayout } from "./ui/layout";
import { HomePage, MlsPage } from "./pages";
import { buildLabRoutes } from "./lab";
import type { ContentStore } from "./content";
import { LISTINGS } from "./listings";

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

// The session cookie name and serializers live in `@lesto/identity`'s cookie
// module — the single source of the `__Host-` discipline. The edge twin reuses
// them rather than re-deriving the contract.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// The edge isolate's per-client rate-limit policy: a small burst, refilled
// steadily. Keyed by the request-context client IP (`cf-connecting-ip`, set by
// Cloudflare and not client-forgeable), so a flood from one client is shed
// before it reaches dispatch. Built once per `buildEdgeApp` call (per isolate),
// which is the lifetime a token bucket must outlive.
const EDGE_RATE_LIMIT = { capacity: 60, refillPerSecond: 10 } as const;

/** What `buildEdgeApp` accepts beyond the signing secret. */
export interface EdgeAppOptions {
  /**
   * The server-render dialect the pages use — default React. The Worker passes
   * `preactServerRenderer` because its bundle is aliased to `preact/compat`
   * (`wrangler.jsonc`), so the buffered SSR markup matches the Preact client
   * bundle the deploy ships (ADR 0008's matched pair). The in-process tests,
   * which run this file unaliased, leave it unset and stream React.
   */
  readonly serverRenderer?: ServerRenderer;

  /**
   * Whether the passwordless `?as=<id>` demo sign-in is reachable.
   *
   * The edge twin's sign-in mints a session for a user id with NO credential
   * check — fine for the public demo, a wide-open auth bypass for a real deploy.
   * It is therefore OFF by default and turned on only under an explicit demo
   * binding (`LESTO_DEMO=1`, resolved by {@link isDemoMode}). With it off, the
   * sign-in route is registered but refuses (403), so a forgotten flag fails
   * closed rather than silently exposing impersonation.
   */
  readonly demo?: boolean;

  /**
   * The DB-driven content store for the `/lab/content/:slug` page (ADR 0004's
   * content duality). On the deployed Worker this is the Cloudflare D1 store
   * (`d1ContentStore(env.DB)`, wired in `worker.ts`); absent, the content page
   * renders a "configure a D1 binding" view rather than 404ing the link.
   */
  readonly contentStore?: ContentStore;
}

/**
 * Build the edge app over a signing secret.
 *
 * The secret backs every signed session; in the Worker it comes from
 * `env.SESSION_SECRET`, never the source. The app mounts the framework's
 * `secureStack` (origin-check CSRF + per-isolate rate limiting) ahead of every
 * route, so a cross-site state-changing request is refused before dispatch and a
 * flood is shed early. This is the node twin's (`app.ts`) origin-check posture
 * PLUS per-isolate rate limiting the edge adds on top (a short-lived Worker
 * isolate cannot lean on long-lived infra for that, so it sheds floods itself).
 */
export function buildEdgeApp(secret: string, options: EdgeAppOptions = {}): Lesto {
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

  const app = lesto()
    // The node twin's origin-check CSRF posture, PLUS per-isolate rate limiting
    // the edge adds on top — both wrap every route (and every 404), applied
    // before any route so a forged cross-site POST or a flood is refused ahead of
    // dispatch.
    .use(...secureStack({ originCheck: {}, rateLimit: EDGE_RATE_LIMIT }).map(fromRequestMiddleware))
    // The edge app IS the root the Worker fronts, so its client-module + layout
    // live right here (unlike node, where buildEstateRoutes is a `.route()` sub).
    .client("/client.js")
    .layout(EstateLayout)
    // The static marketing home: prerendered + cacheable on the deploy, yet its
    // Account island resolves the live signed-token session on the client.
    .page("/", {
      static: true,
      component: HomePage,
      metadata: () => ({
        title: "Jade Mills Estates",
        description:
          "Extraordinary homes, quietly sold across Beverly Hills, Bel Air, and Malibu — browse Jade Mills' luxury listings.",
      }),
    })
    // The dynamic MLS landing page: server-rendered, reflecting the session.
    .page("/mls", {
      load: (c) => {
        const user = currentUser(c.header("cookie"));

        return {
          signedIn: user !== undefined,
          ...(user === undefined ? {} : { name: user.name }),
        };
      },
      component: MlsPage,
      metadata: () => ({
        title: "MLS · Jade Mills Estates",
        description: "Search the Jade Mills MLS and sign in to save listings.",
      }),
    })
    /**
     * The session data source the marketing Account island binds to (ADR 0010).
     *
     * Auto-exposed at `/__lesto/data/session`; the framework delivers its value to
     * the island as a prop (primed parallel with client.js). An identity *probe*,
     * not a gated resource — "nobody is signed in" is a normal `null`/200, never a
     * 401. The signed-token user is already the `{ id, name }` DTO; the gated
     * `/mls/saved` still 401s.
     */
    .data(sessionSource, (c) => currentUser(c.header("cookie")) ?? null)
    // Demo sign-in: mint a SIGNED token for `?as=<id>` (default jade), set the
    // cookie. PASSWORDLESS by design — it impersonates a user id with no
    // credential check — so it is fenced behind the demo flag: off, every request
    // to it is refused (403), never a silent auth bypass.
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
    // The /lab feature-demo zone, on the edge too (DB-driven content over D1).
    .route(buildLabRoutes(options.contentStore));

  // The matched-pair SERVER half (ADR 0008): the Worker passes the Preact
  // renderer (its bundle is aliased), the in-process tests leave it unset (React).
  if (renderer !== undefined) app.renderer(renderer);

  return app;
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
  readonly LESTO_DEMO?: string;
}

/**
 * Is the Worker running in demo mode?
 *
 * Demo mode is the OPT-IN escape hatch that allows the committed fallback secret
 * and the passwordless `?as=` sign-in. It requires an explicit `LESTO_DEMO=1`
 * binding (from the Worker `env` or `process.env`) — anything else, including an
 * absent binding, is NOT demo mode.
 */
export function isDemoMode(env?: EdgeEnv): boolean {
  return (env?.LESTO_DEMO ?? process.env["LESTO_DEMO"]) === "1";
}

/**
 * The signing secret from the environment — FAIL CLOSED.
 *
 * In production (`isDemoMode` false) an absent `SESSION_SECRET` THROWS rather
 * than falling back to a committed literal: a Worker with no trust root must not
 * serve a single request signing sessions anyone can forge. The committed
 * {@link DEMO_EDGE_SECRET} is reachable ONLY under an explicit `LESTO_DEMO=1`
 * binding. This is the framework's pattern for every secret-bearing Worker.
 */
export function edgeSecret(env?: EdgeEnv): string {
  const secret = env?.SESSION_SECRET ?? process.env["SESSION_SECRET"];

  if (secret !== undefined) return secret;

  if (isDemoMode(env)) return DEMO_EDGE_SECRET;

  throw new Error(
    "SESSION_SECRET is not set and LESTO_DEMO is not enabled. Refusing to serve: set the " +
      "SESSION_SECRET wrangler secret (`wrangler secret put SESSION_SECRET`), or set LESTO_DEMO=1 " +
      "to run the public demo with its committed fallback secret.",
  );
}
