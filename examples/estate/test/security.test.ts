/**
 * Security regressions for the estate demo's auth + document layer.
 *
 * These pin the hardening of the six findings in the launch review: prototype
 * pollution in the user lookup, the session cookie's `Secure`/`__Host-`
 * attributes, CSRF on the sign-in/sign-out POSTs, `<script>`-safe and
 * HTML-safe serialization, and the demo-only impersonation fence.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_COOKIE,
  clearCookie,
  csrfTokenForAnon,
  csrfTokenForSession,
  findUser,
  sessionCookie,
  signIn,
  verifyCsrfForAnon,
  verifyCsrfForSession,
} from "../src/auth";
import { island } from "@keel/ui";
import type { UiNode } from "@keel/ui";

import { renderDocument } from "../src/document";
import { buildApp } from "../src/app";
import { registry } from "../src/registry";

// --- 1. Prototype-pollution in findUser ------------------------------------

describe("findUser", () => {
  it("resolves a real seeded user", () => {
    expect(findUser("jade")?.name).toBe("Jade Mills");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "does NOT resolve the inherited Object member %s",
    (key) => {
      expect(findUser(key)).toBeUndefined();
    },
  );
});

// --- 2. Session cookie attributes ------------------------------------------

describe("the session cookie", () => {
  it("uses the __Host- prefix, so the browser enforces Secure + Path=/ + no Domain", () => {
    expect(SESSION_COOKIE).toBe("__Host-keel_session");
  });

  it("is set with Secure, HttpOnly, SameSite, and Path=/", () => {
    const cookie = sessionCookie("abc");

    expect(cookie).toContain("__Host-keel_session=abc");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("clears with the same attributes and an immediate expiry", () => {
    const cookie = clearCookie();

    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=0");
  });
});

// --- 3. CSRF token binding --------------------------------------------------

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

// --- 4/5. Document serialization -------------------------------------------

describe("renderDocument", () => {
  it("HTML-escapes the title so it cannot break out of <title> (XSS)", () => {
    const html = renderDocument(registry, { type: "Page", children: [] }, "</title><script>x</script>");

    expect(html).not.toContain("</title><script>x");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
  });

  it("escapes < > & in the island manifest so attacker props cannot break the script tag", () => {
    // The island's props flow verbatim into the JSON manifest. A prop spelling
    // `</script>` must be escaped, or it closes the manifest <script> early.
    const tree: UiNode = {
      type: "Page",
      children: [island("Account", { evil: "</script><script>alert(1)</script>" })],
    };

    const html = renderDocument(registry, tree, "ok");

    // The raw closing-tag-then-script payload never appears unescaped.
    expect(html).not.toContain("</script><script>alert(1)");
    // It survives only in its escaped form inside the manifest.
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003e");
  });

  it("escapes U+2028/U+2029 in the manifest so a raw line terminator cannot truncate the script", () => {
    // U+2028/U+2029 are valid JSON but raw JS line terminators: left unescaped
    // inside a <script> they end the statement and corrupt the manifest.
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);

    const tree: UiNode = {
      type: "Page",
      children: [island("Account", { evil: `a${lineSeparator}b${paragraphSeparator}c` })],
    };

    const html = renderDocument(registry, tree, "ok");

    // No raw separator survives into the document...
    expect(html).not.toContain(lineSeparator);
    expect(html).not.toContain(paragraphSeparator);
    // ...only the escaped forms do.
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });
});

// --- 3/6. Controller flows: CSRF enforcement + impersonation fence ----------

const FORM = { "content-type": "application/x-www-form-urlencoded" };

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
      body: "_csrf=forged",
    });

    expect(res.status).toBe(403);
  });

  it("accept sign-in with a valid anon CSRF token and set the session cookie", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: FORM,
      body: new URLSearchParams({ _csrf: csrfTokenForAnon() }).toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers["Set-Cookie"]).toContain("__Host-keel_session=");
    expect(res.headers["Set-Cookie"]).toContain("Secure");
  });

  it("reject sign-out with no session/CSRF token (403)", async () => {
    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-out", { headers: FORM, body: "" });

    expect(res.status).toBe(403);
  });
});

// --- 6. Demo impersonation fence --------------------------------------------

describe("the ?as=<id> demo impersonation fence", () => {
  const original = process.env["NODE_ENV"];
  const originalFlag = process.env["KEEL_DEMO_AUTH"];

  beforeEach(() => {
    delete process.env["KEEL_DEMO_AUTH"];
  });

  afterEach(() => {
    process.env["NODE_ENV"] = original;
    if (originalFlag === undefined) delete process.env["KEEL_DEMO_AUTH"];
    else process.env["KEEL_DEMO_AUTH"] = originalFlag;
  });

  it("ignores ?as in production: signs in as the default user, not the impersonated one", async () => {
    process.env["NODE_ENV"] = "production";

    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: FORM,
      query: { as: "guest" },
      body: new URLSearchParams({ _csrf: csrfTokenForAnon() }).toString(),
    });

    expect(res.status).toBe(303);

    // Resolve the minted cookie back to a user via the session endpoint.
    const token = extractToken(res.headers["Set-Cookie"] ?? "");
    const session = await app.handle("GET", "/mls/api/session", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    expect(session.status).toBe(200);
    expect(JSON.parse(session.body).user.id).toBe("jade");
  });

  it("honors ?as outside production (demo affordance)", async () => {
    process.env["NODE_ENV"] = "development";

    const app = buildApp();

    const res = await app.handle("POST", "/mls/api/sign-in", {
      headers: FORM,
      query: { as: "guest" },
      body: new URLSearchParams({ _csrf: csrfTokenForAnon() }).toString(),
    });

    const token = extractToken(res.headers["Set-Cookie"] ?? "");
    const session = await app.handle("GET", "/mls/api/session", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    expect(JSON.parse(session.body).user.id).toBe("guest");
  });
});

/** Pull the session token out of a `Set-Cookie` value. */
function extractToken(setCookie: string): string {
  const first = setCookie.split(";")[0] ?? "";

  return first.slice(first.indexOf("=") + 1);
}

// signIn is exercised indirectly above; assert it stays a usable seam too.
describe("signIn", () => {
  it("mints a session token for a user id", () => {
    expect(signIn("jade").token.length).toBeGreaterThan(0);
  });
});
