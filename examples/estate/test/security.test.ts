/**
 * Security regressions for the estate demo's auth + document layer.
 *
 * These pin CSRF binding on the /mls POSTs, HTML-safe document serialization,
 * and the real-credential login flow that replaced the `?as=<id>` impersonation
 * demo. The impersonation fence is gone because there is no impersonation: a
 * sign-in now goes through `Identity.login` and a wrong password is rejected
 * the same way a real deploy would reject it.
 */

import { describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "@keel/identity";
import { island } from "@keel/ui";
import type { UiNode } from "@keel/ui";

import {
  csrfTokenForAnon,
  csrfTokenForSession,
  verifyCsrfForAnon,
  verifyCsrfForSession,
} from "../src/auth";
import { buildApp } from "../src/app";
import { renderDocument } from "../src/document";
import { registry } from "../src/registry";
import { DEFAULT_DEMO } from "../src/identity";

// ---------------------------------------------------------------------------
// Session cookie attributes — pinned at the @keel/identity boundary; estate's
// `__Host-` prefix discipline now lives there. A regression in the prefix or
// attribute set would show up in @keel/identity's tests, not here.
// ---------------------------------------------------------------------------

describe("the session cookie", () => {
  it("carries the __Host- prefix so the browser enforces Secure + Path=/ + no Domain", () => {
    expect(SESSION_COOKIE).toBe("__Host-keel_session");
  });
});

// ---------------------------------------------------------------------------
// CSRF token binding (estate-owned, not @keel/identity)
// ---------------------------------------------------------------------------

describe("CSRF tokens", () => {
  it("verify for the session/anon they were minted for", () => {
    const sessionToken = "session-xyz";

    expect(verifyCsrfForSession(csrfTokenForSession(sessionToken), sessionToken)).toBe(true);
    expect(verifyCsrfForAnon(csrfTokenForAnon())).toBe(true);
  });

  it("do NOT verify across a different session (lateral replay)", () => {
    const token = csrfTokenForSession("session-a");

    expect(verifyCsrfForSession(token, "session-b")).toBe(false);
  });

  it("reject a garbage token", () => {
    expect(verifyCsrfForAnon("not-a-token")).toBe(false);
    expect(verifyCsrfForSession("not-a-token", "session")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Document serialization
// ---------------------------------------------------------------------------

describe("renderDocument", () => {
  it("HTML-escapes the title so it cannot break out of <title> (XSS)", () => {
    const html = renderDocument(
      registry,
      { type: "Page", children: [] },
      "</title><script>x</script>",
    );

    expect(html).not.toContain("</title><script>x");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
  });

  it("escapes < > & in the island manifest so attacker props cannot break the script tag", () => {
    const tree: UiNode = {
      type: "Page",
      children: [island("Account", { evil: "</script><script>alert(1)</script>" })],
    };

    const html = renderDocument(registry, tree, "ok");

    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003e");
  });

  it("escapes U+2028/U+2029 in the manifest so a raw line terminator cannot truncate the script", () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);

    const tree: UiNode = {
      type: "Page",
      children: [island("Account", { evil: `a${lineSeparator}b${paragraphSeparator}c` })],
    };

    const html = renderDocument(registry, tree, "ok");

    expect(html).not.toContain(lineSeparator);
    expect(html).not.toContain(paragraphSeparator);
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });
});

// ---------------------------------------------------------------------------
// /mls POST handlers — CSRF enforcement + real credential checks
// ---------------------------------------------------------------------------

const FORM = { "content-type": "application/x-www-form-urlencoded" };

function signInBody(
  csrf: string,
  email = DEFAULT_DEMO.email,
  password = DEFAULT_DEMO.password,
): string {
  return new URLSearchParams({ _csrf: csrf, email, password }).toString();
}

describe("the /mls POST handlers", () => {
  it("reject sign-in with no CSRF token (403)", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", { headers: FORM, body: "" });

    expect(res.status).toBe(403);
  });

  it("reject sign-in with a forged CSRF token (403)", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: FORM,
      body: signInBody("forged"),
    });

    expect(res.status).toBe(403);
  });

  it("accept sign-in with a valid CSRF token + valid demo credentials, and set the session cookie", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: FORM,
      body: signInBody(csrfTokenForAnon()),
    });

    expect(res.status).toBe(303);
    expect(res.headers["Set-Cookie"]).toContain("__Host-keel_session=");
    expect(res.headers["Set-Cookie"]).toContain("Secure");
  });

  // The crux of "no impersonation": you must KNOW the password. CSRF clears,
  // but Identity rejects the bad credential — that's a 401, not a 303.
  it("reject sign-in with a valid CSRF token but a wrong password (401)", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: FORM,
      body: signInBody(csrfTokenForAnon(), DEFAULT_DEMO.email, "not-the-real-password"),
    });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ code: "IDENTITY_INVALID_CREDENTIALS" });
  });

  it("reject sign-in for an unknown email with the same generic error (no enumeration)", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: FORM,
      body: signInBody(csrfTokenForAnon(), "nobody@nowhere.example", DEFAULT_DEMO.password),
    });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ code: "IDENTITY_INVALID_CREDENTIALS" });
  });

  it("reject sign-out with no session/CSRF token (403)", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-out", { headers: FORM, body: "" });

    expect(res.status).toBe(403);
  });
});
