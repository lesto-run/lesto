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

import { toFetchHandler } from "@keel/cloudflare";

import { buildEdgeApp } from "../src/edge";

const SECRET = "edge-e2e-secret";

/** The Worker's fetch handler, built over the edge app with `secret`. */
function handlerFor(secret: string): (request: Request) => Promise<Response> {
  const app = buildEdgeApp(secret);

  return toFetchHandler((method, path, options) => app.handle(method, path, options));
}

const origin = "https://estate.example.com";

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
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST" }),
    );

    expect(signIn.status).toBe(303);

    const setCookie = signIn.headers.get("set-cookie");
    expect(setCookie).toContain("__Host-keel_session=");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");

    const cookie = sessionCookiePair(setCookie ?? "");

    const saved = await handler(new Request(`${origin}/mls/saved`, { headers: { cookie } }));
    expect(saved.status).toBe(200);

    const body = (await saved.json()) as { user: { id: string }; saved: unknown[] };
    expect(body.user.id).toBe("jade");
    expect(body.saved).toHaveLength(2);
  });

  it("the session endpoint the marketing island calls reflects the cookie", async () => {
    const handler = handlerFor(SECRET);

    const anon = await handler(new Request(`${origin}/mls/api/session`));
    expect(anon.status).toBe(401);

    const signIn = await handler(
      new Request(`${origin}/mls/api/sign-in?as=guest`, { method: "POST" }),
    );
    const cookie = sessionCookiePair(signIn.headers.get("set-cookie") ?? "");

    const session = await handler(
      new Request(`${origin}/mls/api/session`, { headers: { cookie } }),
    );
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user: { name: string } }).user.name).toBe("Guest Buyer");
  });

  it("verifies across isolates: a cookie from one handler is accepted by another with the same secret and no shared store", async () => {
    const issuer = handlerFor(SECRET);
    const otherIsolate = handlerFor(SECRET); // fresh app, fresh (empty) memory — like a new PoP

    const signIn = await issuer(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST" }),
    );
    const cookie = sessionCookiePair(signIn.headers.get("set-cookie") ?? "");

    const saved = await otherIsolate(new Request(`${origin}/mls/saved`, { headers: { cookie } }));

    expect(saved.status).toBe(200); // stateless: no store was consulted, the signature is the proof
  });

  it("rejects a cookie signed with a different secret (forged)", async () => {
    const attacker = handlerFor("a-different-secret");
    const real = handlerFor(SECRET);

    const forged = await attacker(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST" }),
    );
    const cookie = sessionCookiePair(forged.headers.get("set-cookie") ?? "");

    const saved = await real(new Request(`${origin}/mls/saved`, { headers: { cookie } }));

    expect(saved.status).toBe(401);
  });

  it("serves the marketing page with the Account island shell", async () => {
    const handler = handlerFor(SECRET);

    const response = await handler(new Request(`${origin}/`));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("data-keel-island");
    expect(html).toContain("Jade Mills Estates");
  });
});
