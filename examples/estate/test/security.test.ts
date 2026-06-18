/**
 * Security regressions for the estate demo's auth layer.
 *
 * These pin CSRF binding on the /mls POSTs, the no-store per-user session route,
 * and the real-credential login flow that replaced the `?as=<id>` impersonation
 * demo. The impersonation fence is gone because there is no impersonation: a
 * sign-in now goes through `Identity.login` and a wrong password is rejected the
 * same way a real deploy would reject it.
 *
 * Document/manifest XSS escaping is no longer asserted here: the pages render
 * through the framework's `.page` seam now, and that escaping (title/meta via
 * `@volo/ui`'s `renderMetadata`, island props via `serializeScriptJson`) is
 * pinned at 100% coverage in `@volo/ui` and `@volo/web` themselves.
 */

import { describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "@volo/identity";

import { buildApp } from "../src/app";
import { DEFAULT_DEMO } from "../src/identity";

// ---------------------------------------------------------------------------
// Session cookie attributes — pinned at the @volo/identity boundary; estate's
// `__Host-` prefix discipline now lives there. A regression in the prefix or
// attribute set would show up in @volo/identity's tests, not here.
// ---------------------------------------------------------------------------

describe("the session cookie", () => {
  it("carries the __Host- prefix so the browser enforces Secure + Path=/ + no Domain", () => {
    expect(SESSION_COOKIE).toBe("__Host-volo_session");
  });
});

// ---------------------------------------------------------------------------
// /mls POST handlers — CSRF via the originCheck middleware + real credentials
//
// CSRF is now the framework's `secureStack({ originCheck })`: a state-changing
// request is refused (403) before dispatch unless the browser's `Sec-Fetch-Site`
// says it came from us. So a same-origin form post carries that header; a
// cross-site one (or a client that sends no origin signal at all) is refused.
// ---------------------------------------------------------------------------

const FORM = { "content-type": "application/x-www-form-urlencoded" };

// A same-origin browser form post — what originCheck must let through.
const SAME_ORIGIN = { ...FORM, "sec-fetch-site": "same-origin" };

// A cross-site initiator — the CSRF vector originCheck must refuse.
const CROSS_SITE = { ...FORM, "sec-fetch-site": "cross-site" };

function signInBody(email = DEFAULT_DEMO.email, password = DEFAULT_DEMO.password): string {
  return new URLSearchParams({ email, password }).toString();
}

describe("the /mls POST handlers", () => {
  it("reject a sign-in carrying no origin signal (403, before the controller)", async () => {
    const app = await buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", { headers: FORM, body: signInBody() });

    expect(res.status).toBe(403);
  });

  it("reject a cross-site sign-in (403)", async () => {
    const app = await buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: CROSS_SITE,
      body: signInBody(),
    });

    expect(res.status).toBe(403);
  });

  it("accept a same-origin sign-in with valid demo credentials, and set the session cookie", async () => {
    const app = await buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN,
      body: signInBody(),
    });

    expect(res.status).toBe(303);
    expect(res.headers["Set-Cookie"]).toContain("__Host-volo_session=");
    expect(res.headers["Set-Cookie"]).toContain("Secure");
  });

  // The crux of "no impersonation": you must KNOW the password. Origin clears,
  // but Identity rejects the bad credential — that's a 401, not a 303.
  it("reject a same-origin sign-in with a wrong password (401)", async () => {
    const app = await buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN,
      body: signInBody(DEFAULT_DEMO.email, "not-the-real-password"),
    });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ code: "IDENTITY_INVALID_CREDENTIALS" });
  });

  it("reject sign-in for an unknown email with the same generic error (no enumeration)", async () => {
    const app = await buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: SAME_ORIGIN,
      body: signInBody("nobody@nowhere.example", DEFAULT_DEMO.password),
    });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ code: "IDENTITY_INVALID_CREDENTIALS" });
  });

  it("reject a cross-site sign-out (403, before the controller)", async () => {
    const app = await buildApp();

    const res = await app.handle("POST", "/mls/api/sign-out", { headers: CROSS_SITE, body: "" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The auto-exposed session data route — per-user JSON must never be
// shared-cacheable (ADR 0010 §3a). `sessionSource` is private (the default), so
// `volo().data()` answers it with `Cache-Control: private, no-store`. This is
// the live launch-hardening surface: a missing header here is a session leak
// waiting for a CDN.
// ---------------------------------------------------------------------------

describe("the /__volo/data/session route", () => {
  it("is no-store — the per-user session JSON is never written to a shared cache", async () => {
    const app = await buildApp();

    const res = await app.handle("GET", "/__volo/data/session");

    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
