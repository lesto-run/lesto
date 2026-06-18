/**
 * End-to-end proof of edge auth through the Worker adapter.
 *
 * A Cloudflare Worker is `fetch(Request) => Response`, and Node 22 ships the same
 * global `Request`/`Response`, so this drives the *exact* handler the Worker runs
 * — no Workers runtime needed. It proves the launch-critical loop: a signed-out
 * request is refused, sign-in mints a signed cookie, that cookie unlocks the
 * gated resource, and — the property that makes auth work on ephemeral, per-PoP
 * isolates — a SECOND handler with the same secret and NO shared store accepts a
 * cookie the first one issued.
 */

import { describe, expect, it } from "vitest";

import { toFetchHandler } from "@lesto/cloudflare";

import { buildEdgeApp } from "../src/edge";

// >= 32 bytes: the secret-strength guard rejects shorter signing secrets.
const SECRET = "edge-e2e-secret-0123456789abcdefg";

const origin = "https://estate.example.com";

// A same-origin browser POST — what the edge originCheck must let through. The
// secureStack on the edge refuses a state-changing request with no origin signal,
// so every POST in this suite carries `Sec-Fetch-Site: same-origin`.
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/**
 * The Worker's fetch handler, built over the edge app with `secret`. Demo mode
 * is on (the setup file sets LESTO_DEMO=1), so the passwordless `?as=` sign-in
 * the auth flow uses is reachable.
 */
function handlerFor(secret: string): (request: Request) => Promise<Response> {
  const app = buildEdgeApp(secret, { demo: true });

  return toFetchHandler((method, path, options) => app.handle(method, path, options));
}

/** Pull the session cookie's `name=value` out of a `Set-Cookie` header. */
function sessionCookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

describe("estate on the edge — signed-session auth through toFetchHandler", () => {
  it("refuses the gated resource when signed out", async () => {
    const handler = handlerFor(SECRET);

    const response = await handler(new Request(`${origin}/mls/saved`));

    expect(response.status).toBe(401);
  });

  it("signs in (signed cookie), then the cookie unlocks the gated resource", async () => {
    const handler = handlerFor(SECRET);

    const signIn = await handler(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST", headers: SAME_ORIGIN }),
    );

    expect(signIn.status).toBe(303);

    const setCookie = signIn.headers.get("set-cookie");
    expect(setCookie).toContain("__Host-lesto_session=");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");

    const cookie = sessionCookiePair(setCookie ?? "");

    const saved = await handler(new Request(`${origin}/mls/saved`, { headers: { cookie } }));
    expect(saved.status).toBe(200);

    const body = (await saved.json()) as { user: { id: string }; saved: unknown[] };
    expect(body.user.id).toBe("jade");
    expect(body.saved).toHaveLength(2);
  });

  it("the session source the marketing island binds reflects the cookie", async () => {
    const handler = handlerFor(SECRET);

    // The Account island binds this source (ADR 0010); the worker auto-exposes
    // it at /__lesto/data/session (a miss on the assets binding falls through to
    // the app). Signed out is a normal answer: 200 with the value `null`, not a
    // 401 (a 401 would log a browser console error on every public view). The
    // value is the user directly — no `{ user }` wrapper.
    const anon = await handler(new Request(`${origin}/__lesto/data/session`));
    expect(anon.status).toBe(200);
    expect(await anon.json()).toBeNull();

    const signIn = await handler(
      new Request(`${origin}/mls/api/sign-in?as=guest`, { method: "POST", headers: SAME_ORIGIN }),
    );
    const cookie = sessionCookiePair(signIn.headers.get("set-cookie") ?? "");

    const session = await handler(
      new Request(`${origin}/__lesto/data/session`, { headers: { cookie } }),
    );
    expect(session.status).toBe(200);
    expect(((await session.json()) as { name: string }).name).toBe("Guest Buyer");
  });

  it("verifies across isolates: a cookie from one handler is accepted by another with the same secret and no shared store", async () => {
    const issuer = handlerFor(SECRET);
    const otherIsolate = handlerFor(SECRET); // fresh app, fresh (empty) memory — like a new PoP

    const signIn = await issuer(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST", headers: SAME_ORIGIN }),
    );
    const cookie = sessionCookiePair(signIn.headers.get("set-cookie") ?? "");

    const saved = await otherIsolate(new Request(`${origin}/mls/saved`, { headers: { cookie } }));

    expect(saved.status).toBe(200); // stateless: no store was consulted, the signature is the proof
  });

  it("rejects a cookie signed with a different secret (forged)", async () => {
    const attacker = handlerFor("a-different-secret-0123456789abcde");
    const real = handlerFor(SECRET);

    const forged = await attacker(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST", headers: SAME_ORIGIN }),
    );
    const cookie = sessionCookiePair(forged.headers.get("set-cookie") ?? "");

    const saved = await real(new Request(`${origin}/mls/saved`, { headers: { cookie } }));

    expect(saved.status).toBe(401);
  });

  it("serves the /mls landing page with the listings", async () => {
    const handler = handlerFor(SECRET);

    const response = await handler(new Request(`${origin}/mls`));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("MLS Search");
    expect(html).toContain("Bel Air Glen Estate");
  });

  it("serves the marketing page with the Account island shell", async () => {
    const handler = handlerFor(SECRET);

    const response = await handler(new Request(`${origin}/`));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("data-lesto-island");
    expect(html).toContain("Jade Mills Estates");
  });
});
