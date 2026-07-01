/**
 * The estate's routes for both zones, on one composable `lesto()` app.
 *
 *   marketing (`/`, `/about`) — the static zone. Registered `static: true`, so the
 *   pages prerender to cacheable HTML yet carry the auth-aware `Account` island:
 *   no render-time session is baked in, the client resolves it (ADR 0010/0012).
 *
 *   mls (`/mls/*`) — the dynamic zone. It owns the session: it mints the cookie on
 *   sign-in via `Identity.login`, answers `/__lesto/data/session` with the current
 *   user (what the marketing island binds), and gates `/mls/saved`.
 *
 * Built through a factory so the handlers close over their own {@link Identity}
 * (no module-scoped DB handle). Pages are plain React (`pages.tsx`) rendered by
 * `.page`, wrapped in the `EstateLayout`; the client runtime module is declared on
 * the ROOT app (app.ts `.client(...)`), because `.route()` composes a sub-app's
 * routes/layouts/data but not its client-module config.
 */

import { lesto } from "@lesto/web";
import type { Context, Lesto } from "@lesto/web";
import type { PrincipalResolverOptions } from "@lesto/authz";

import {
  clearSessionCookie,
  IdentityError,
  readSessionToken,
  sessionCookie,
} from "@lesto/identity";
import type { Identity } from "@lesto/identity";

import { sessionSource } from "./session-source";
import { buildAssistantRoutes } from "./assistant";
import type { AssistantAuth, AssistantWiring } from "./assistant";
import { EstateLayout } from "./ui/layout";
import { HomePage, AboutPage, MlsPage } from "./pages";
import { StyleGuidePage } from "./styleguide";
import { buildLabRoutes } from "./lab";
import { nodeContentStore } from "./content-node";
import { LISTINGS } from "./listings";
import { DEFAULT_DEMO, DEMO_ACCOUNTS } from "./identity";

/** What the client sees on `/__lesto/data/session` — the same shape the Account island consumes. */
interface SessionResponseUser {
  readonly id: string;
  readonly name: string;
}

/**
 * Pull a single field out of a urlencoded form body.
 *
 * The runtime hands a non-JSON body through as the raw string, so a form POST
 * arrives as `"_csrf=abc&email=x&password=y"`. Returns `undefined` when the body
 * is not a string or the field is absent — callers treat that as "not supplied".
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

/**
 * The estate app's routes, closing over the {@link Identity} they authenticate
 * against. `rolesOf` is the durable `user_roles` seam (OCP-5) bound to the same
 * identity DB — threaded into the lab so its authz resolves real, persisted roles.
 */
export function buildEstateRoutes(
  identity: Identity,
  rolesOf: PrincipalResolverOptions["rolesOf"],
  assistant?: AssistantWiring,
): Lesto {
  /** The current user (an Identity model), or undefined when signed out. */
  const currentUser = async (c: Context): Promise<{ email: string } | undefined> => {
    const user = await identity.currentUser(readSessionToken(c.header("cookie")));

    return user === undefined ? undefined : { email: user.email };
  };

  /**
   * The lab's session→principal seam (ADR 0028): verify the request's session and
   * hand back its `userId` for the `rolesOf` store. Keyed by the demo account id
   * (`jade`/`guest`) — the same key the roles were seeded under — so a signed-in
   * Jade resolves `["admin"]`; a non-demo user falls back to their email (no roles
   * → denied).
   */
  const verifyLabSession = async (c: Context): Promise<{ userId: string } | undefined> => {
    const user = await currentUser(c);

    if (user === undefined) return undefined;

    const demoId = DEMO_ACCOUNTS.find((d) => d.email === user.email)?.id;

    return { userId: demoId ?? user.email };
  };

  /**
   * The AI concierge's auth seam (ADR 0031 Inc 4): resolve the caller from the
   * durable {@link Identity} — the read that produces the `db.query` leg of the
   * dogfood trace — and hand the assistant route a minimal `{ id, name }`.
   */
  const authenticateAssistant: AssistantAuth = async (c) => {
    const user = await currentUser(c);

    return user === undefined ? undefined : { id: user.email, name: displayNameFor(user.email) };
  };

  return (
    lesto()
      .layout(EstateLayout)
      // --- marketing (static) zone ---
      // Prerendered + cacheable, yet auth-aware: `static: true` renders with no
      // render-time resolver, so the Account island binds + primes its session
      // for the CLIENT to resolve, never baking a build-time value into the file.
      .page("/", {
        static: true,
        component: HomePage,
        metadata: () => ({
          title: "Jade Mills Estates",
          description:
            "Extraordinary homes, quietly sold across Beverly Hills, Bel Air, and Malibu — browse Jade Mills' luxury listings.",
        }),
      })
      .page("/about", {
        static: true,
        component: AboutPage,
        metadata: () => ({
          title: "About · Jade Mills Estates",
          description:
            "Four decades at the top of luxury real estate — about Jade Mills and the Jade Mills Estates marketing site.",
        }),
      })
      // A static design-system gallery — no islands, pure prerendered showcase.
      .page("/styleguide", {
        static: true,
        component: StyleGuidePage,
        metadata: () => ({
          title: "Style Guide · Jade Mills Estates",
          description: "The estate design system — a living gallery of every UI primitive.",
        }),
      })
      // --- mls (dynamic) zone ---
      // Server-rendered per request: its `load` reads the session and renders the
      // matching sign-in/greeting. Dynamic (no `static`), so it is no-store.
      .page("/mls", {
        load: async (c) => {
          const user = await currentUser(c);
          const name = user === undefined ? undefined : displayNameFor(user.email);

          return {
            signedIn: user !== undefined,
            ...(name === undefined ? {} : { name }),
            demoEmail: DEFAULT_DEMO.email,
            demoPassword: DEFAULT_DEMO.password,
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
       * the island as a prop (primed parallel with client.js on the static page).
       * An identity *probe*, not a gated resource — "nobody is signed in" is a
       * normal answer (`null`, 200), never a 401. The DTO is allowlisted to
       * `{ id, name }`; the gated resources (`/mls/saved`, any POST) still 401/403.
       */
      .data(sessionSource, async (c) => {
        const user = await currentUser(c);

        return user === undefined ? null : sessionUser(user.email);
      })
      /**
       * Sign in — runs the real `Identity.login` flow.
       *
       * CSRF is handled upstream by the `originCheck` middleware (`secureStack`):
       * a cross-site POST is refused with a 403 before dispatch. The form POSTs
       * `email` and `password`; bad credentials surface as 401.
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
       * Sign out: revoke the session and clear the cookie. The `originCheck`
       * middleware refuses a cross-site POST before it arrives. Revoking is
       * idempotent — a request without a session token just clears the cookie.
       */
      .post("/mls/api/sign-out", async (c) => {
        const sessionToken = readSessionToken(c.header("cookie"));

        await identity.logout(sessionToken);

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
      /**
       * Begin TOTP (2FA) enrollment for the signed-in user (ADR 0020).
       *
       * Returns the base32 secret plus the `otpauth://` provisioning URI the user
       * scans into an authenticator app (rendered as a QR by any QR library). The
       * secret is returned only here, never re-fetchable. A signed-out caller, or
       * one whose factor is already confirmed, gets a coded error.
       */
      .post("/mls/api/totp/enroll", async (c) => {
        const token = readSessionToken(c.header("cookie"));

        try {
          const { secret, keyUri } = await identity.enrollTotp(token);

          return c.json({ secret, keyUri });
        } catch (error) {
          if (error instanceof IdentityError) {
            return c.json(
              { error: error.code },
              error.code === "IDENTITY_NOT_AUTHENTICATED" ? 401 : 409,
            );
          }

          throw error;
        }
      })
      /**
       * Confirm enrollment with the first authenticator code. On success returns
       * the one-time-visible recovery codes; a wrong code is a 400.
       */
      .post("/mls/api/totp/confirm", async (c) => {
        const token = readSessionToken(c.header("cookie"));
        const code = formField(c.req.body, "code") ?? "";

        try {
          const { recoveryCodes } = await identity.confirmTotp(token, code);

          return c.json({ status: "enrolled", recoveryCodes });
        } catch (error) {
          if (error instanceof IdentityError) {
            return c.json(
              { error: error.code },
              error.code === "IDENTITY_NOT_AUTHENTICATED" ? 401 : 400,
            );
          }

          throw error;
        }
      })
      /**
       * Verify a second-factor challenge — the step the app runs after a password
       * login when the user has a confirmed factor. A code OR a single-use recovery
       * code is accepted; a bad code is a 401.
       */
      .post("/mls/api/totp/challenge", async (c) => {
        // The challenge needs the user *id*, so resolve the full identity user
        // (the local `currentUser` narrows to `{ email }`).
        const user = await identity.currentUser(readSessionToken(c.header("cookie")));

        if (user === undefined) return c.json({ error: "sign in required" }, 401);

        const code = formField(c.req.body, "code") ?? "";
        const recovery = formField(c.req.body, "recovery") === "1";

        try {
          if (recovery) {
            await identity.verifyRecoveryCode(user.id, code);
          } else {
            await identity.verifyTotpChallenge(user.id, code);
          }

          return c.json({ status: "verified" });
        } catch (error) {
          if (error instanceof IdentityError) {
            return c.json({ error: error.code }, 401);
          }

          throw error;
        }
      })
      // The AI concierge (ADR 0031 Inc 4): the first `@lesto/ai` route consumer.
      // An authed `runAgent` loop grounded in the MLS `searchListings` tool; with
      // the injected tracer wired (serve.ts), its `ai.generate`/`ai.tool` spans
      // land on the request trace — the in-request agent join, dogfooded.
      .route(buildAssistantRoutes({ authenticate: authenticateAssistant, ...(assistant ?? {}) }))
      // The /lab feature-demo zone (SSR + CSR fetch, async data, flags, authz,
      // DB-driven content over portable SQLite). The lab's admin gate + CRUD read
      // their principal from the SAME identity session minted by `/mls` sign-in, and
      // its roles from the durable `user_roles` store (OCP-5) — no `?role=` knob.
      .route(buildLabRoutes(nodeContentStore(), verifyLabSession, rolesOf))
  );
}
