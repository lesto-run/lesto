/**
 * Integration test for the production serve pipeline.
 *
 * Where the unit tests mock the asset layer, this boots the *real* assembly —
 * `buildProductionSite` (prerender + bundle `client.js` + the path-mount
 * dispatcher), the same function `serve.ts` runs — into a temp directory and
 * drives it over the dispatcher exactly as the HTTP server would. It exists
 * because live QA caught a bug no unit test could: the prerendered page loads
 * `/client.js`, but nothing built or served it, so the island never hydrated in
 * production. The "serves /client.js" case below is that bug, pinned.
 *
 * It also walks the full authenticated journey — including CSRF, which a unit
 * test of a single handler cannot exercise end to end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProductionSite } from "../src/production";
import type { SiteDispatch } from "../src/production";
import { DEFAULT_DEMO } from "../src/identity";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

let outDir: string;
let dispatch: SiteDispatch;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "estate-prod-"));

  // The real pipeline: prerender the marketing zone + bundle the island client.
  ({ dispatch } = await buildProductionSite(outDir, PROJECT_ROOT));
}, 30_000); // the bun bundle step needs headroom beyond the default timeout

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

/** Pull the session cookie's `name=value` out of a `Set-Cookie` header (now a multimap, so a list is possible). */
function cookieFrom(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (first ?? "").split(";")[0] ?? "";
}

// A same-origin browser form post: content-type + the Fetch-Metadata signal
// `originCheck` reads to admit a state-changing request.
const SAME_ORIGIN_FORM = {
  "content-type": "application/x-www-form-urlencoded",
  "sec-fetch-site": "same-origin",
};

describe("the prerendered marketing zone", () => {
  it("serves the home page with the island shell and a manifest", async () => {
    const response = await dispatch("GET", "/");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("data-keel-island");
    // The co-located mount script `defineIsland` emits (replaces the old single
    // `<script id="keel-islands">` manifest) — carrying the Account island's name.
    expect(response.body).toContain("data-keel-island-mount");
    expect(response.body).toContain('"component":"Account"');
    expect(response.body).toContain('src="/client.js"');
  });

  it("serves /client.js — the island bundle the page loads (the regression this test exists for)", async () => {
    const response = await dispatch("GET", "/client.js");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.body.length).toBeGreaterThan(1000); // a real bundle, not an empty/HTML 404
  });

  it("serves the prerendered /about page", async () => {
    const response = await dispatch("GET", "/about");

    expect(response.status).toBe(200);
    expect(response.body).toContain("About Jade");
  });

  it("404s a path no zone owns", async () => {
    expect((await dispatch("GET", "/does-not-exist")).status).toBe(404);
  });
});

describe("the dynamic /mls zone — the authenticated journey", () => {
  it("gates the saved resource when signed out", async () => {
    expect((await dispatch("GET", "/mls/saved")).status).toBe(401);
  });

  it("answers the session source with 200 null when signed out (not a 401 — that logs a console error)", async () => {
    // The marketing Account island binds this source (ADR 0010); the framework
    // auto-exposes it at /__keel/data/session, which dispatchSites routes to the
    // live app even though the `/` catch-all zone's prefix would otherwise claim
    // it. The value is the user directly (or null), no `{ user }` wrapper.
    const response = await dispatch("GET", "/__keel/data/session");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toBeNull();
  });

  it("rejects a sign-in POST carrying no origin signal (CSRF)", async () => {
    expect(
      (
        await dispatch("POST", "/mls/api/sign-in", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            email: DEFAULT_DEMO.email,
            password: DEFAULT_DEMO.password,
          }).toString(),
        })
      ).status,
    ).toBe(403);
  });

  it("signs in with the demo credentials, then the cookie unlocks the gated resource", async () => {
    // Sign in with the real demo credentials. The same-origin Fetch-Metadata
    // signal clears originCheck, the password clears Identity.login, and a
    // session cookie comes back. The body is the raw urlencoded string the HTTP
    // server delivers — the runtime only JSON-parses bodies, so the controller
    // parses the form itself.
    const signIn = await dispatch("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN_FORM,
      body: new URLSearchParams({
        email: DEFAULT_DEMO.email,
        password: DEFAULT_DEMO.password,
      }).toString(),
    });
    expect(signIn.status).toBe(303);

    const cookie = cookieFrom(signIn.headers["Set-Cookie"] ?? signIn.headers["set-cookie"]);
    expect(cookie).toContain("keel_session");

    // 3. The session source the marketing island binds now resolves the user.
    const session = await dispatch("GET", "/__keel/data/session", { headers: { cookie } });
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toEqual({
      id: DEFAULT_DEMO.email,
      name: DEFAULT_DEMO.displayName,
    });

    // 4. And the gated resource is unlocked.
    const saved = await dispatch("GET", "/mls/saved", { headers: { cookie } });
    expect(saved.status).toBe(200);
    expect((JSON.parse(saved.body) as { saved: unknown[] }).saved.length).toBeGreaterThan(0);
  });

  it("sign-out revokes the session: the old cookie no longer resolves the user", async () => {
    // Sign in and confirm the session resolves (the row is in the SQL store).
    const signIn = await dispatch("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN_FORM,
      body: new URLSearchParams({
        email: DEFAULT_DEMO.email,
        password: DEFAULT_DEMO.password,
      }).toString(),
    });
    const cookie = cookieFrom(signIn.headers["Set-Cookie"] ?? signIn.headers["set-cookie"]);

    const before = await dispatch("GET", "/__keel/data/session", { headers: { cookie } });
    expect(JSON.parse(before.body)).toEqual({
      id: DEFAULT_DEMO.email,
      name: DEFAULT_DEMO.displayName,
    });

    // Sign out: this drives sqlSessionStore.delete through the full HTTP journey.
    const signOut = await dispatch("POST", "/mls/api/sign-out", {
      headers: { ...SAME_ORIGIN_FORM, cookie },
      body: "",
    });
    expect(signOut.status).toBe(303);

    // The same cookie now resolves nobody — the row was deleted, not just the
    // cookie cleared. (Re-presenting the revoked token yields signed-out.)
    const after = await dispatch("GET", "/__keel/data/session", { headers: { cookie } });
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body)).toBeNull();
  });

  // The replacement for the old `?as=<id>` impersonation fence: there is no
  // fence because there is no impersonation — wrong creds are wrong creds.
  it("rejects a same-origin sign-in POST that uses a wrong password", async () => {
    const signIn = await dispatch("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN_FORM,
      body: new URLSearchParams({
        email: DEFAULT_DEMO.email,
        password: "not-the-real-one",
      }).toString(),
    });

    expect(signIn.status).toBe(401);
  });
});
