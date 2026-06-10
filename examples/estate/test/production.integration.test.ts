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

/** Pull the CSRF token a rendered `/mls` form carries. */
function csrfFrom(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);

  return match?.[1] ?? "";
}

/** Pull the session cookie's `name=value` out of a `Set-Cookie` header. */
function cookieFrom(setCookie: string | undefined): string {
  return (setCookie ?? "").split(";")[0] ?? "";
}

describe("the prerendered marketing zone", () => {
  it("serves the home page with the island shell and a manifest", async () => {
    const response = await dispatch("GET", "/");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("data-keel-island");
    expect(response.body).toContain('id="keel-islands"');
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
  it("gates the saved resource and the session endpoint when signed out", async () => {
    expect((await dispatch("GET", "/mls/saved")).status).toBe(401);
    expect((await dispatch("GET", "/mls/api/session")).status).toBe(401);
  });

  it("rejects a sign-in POST with no CSRF token", async () => {
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
    // 1. The /mls page carries a CSRF token in its sign-in form.
    const page = await dispatch("GET", "/mls");
    const csrf = csrfFrom(page.body);
    expect(csrf.length).toBeGreaterThan(0);

    // 2. Sign in with the real demo credentials. The token clears CSRF, the
    // password clears Identity.login, and a session cookie comes back. The
    // body is the raw urlencoded string the HTTP server delivers — the runtime
    // only JSON-parses bodies, so the controller parses the form itself.
    const signIn = await dispatch("POST", "/mls/api/sign-in", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrf,
        email: DEFAULT_DEMO.email,
        password: DEFAULT_DEMO.password,
      }).toString(),
    });
    expect(signIn.status).toBe(303);

    const cookie = cookieFrom(signIn.headers["Set-Cookie"] ?? signIn.headers["set-cookie"]);
    expect(cookie).toContain("keel_session");

    // 3. The session endpoint the marketing island calls now sees the user.
    const session = await dispatch("GET", "/mls/api/session", { headers: { cookie } });
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toEqual({
      user: { id: DEFAULT_DEMO.email, name: DEFAULT_DEMO.displayName },
    });

    // 4. And the gated resource is unlocked.
    const saved = await dispatch("GET", "/mls/saved", { headers: { cookie } });
    expect(saved.status).toBe(200);
    expect((JSON.parse(saved.body) as { saved: unknown[] }).saved.length).toBeGreaterThan(0);
  });

  // The replacement for the old `?as=<id>` impersonation fence: there is no
  // fence because there is no impersonation — wrong creds are wrong creds.
  it("rejects a sign-in POST that clears CSRF but uses a wrong password", async () => {
    const page = await dispatch("GET", "/mls");
    const csrf = csrfFrom(page.body);

    const signIn = await dispatch("POST", "/mls/api/sign-in", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrf,
        email: DEFAULT_DEMO.email,
        password: "not-the-real-one",
      }).toString(),
    });

    expect(signIn.status).toBe(401);
  });
});
