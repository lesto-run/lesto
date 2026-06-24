/**
 * The /lab feature-demo zone, driven through the real node app.
 *
 * One assertion per capability the lab page-set exists to exercise: SSR data
 * fetching with a typed param, shell-first streaming, the feature-flag gate, the
 * deny-by-default authz gate, and the data route the CSR LiveListing island calls.
 */

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { DEFAULT_DEMO, DEMO_ACCOUNTS } from "../src/identity";
import type { DemoAccount } from "../src/identity";
import type { LestoResponse } from "@lesto/web";

/** Drain a page's streamed body (or pass a string body through) for assertions. */
async function body(response: LestoResponse): Promise<string> {
  if (typeof response.body === "string") return response.body;

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let out = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    out += decoder.decode(read.value, { stream: true });
  }

  return out + decoder.decode();
}

/** Mint the double-submit CSRF token the SaveNote island reads back, via its route. */
async function csrfToken(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.handle("GET", "/lab/api/csrf");

  return (JSON.parse(response.body) as { token: string }).token;
}

/**
 * POST the named mutation with a JSON body + optional CSRF header.
 *
 * Estate guards every state-changing request app-wide with `originCheck`
 * (`secureStack`), so a same-origin browser POST carries `Sec-Fetch-Site:
 * same-origin` — we send it here so the request clears that OUTER gate and reaches
 * the mutation boundary's OWN double-submit token check (the defense-in-depth the
 * ADR notes estate runs).
 */
function callMutation(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  input: unknown,
  token?: string,
): Promise<LestoResponse> {
  return app.handle("POST", `/__lesto/mutations/${name}`, {
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(token === undefined ? {} : { "x-csrf-token": token }),
    },
    body: input,
  });
}

describe("/lab — SSR data fetching + typed param", () => {
  it("resolves a listing by :id on the server", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/listings/bel-air-glen");

    expect(response.status).toBe(200);
    expect(await body(response)).toContain("Bel Air Glen Estate");
  });

  it("renders a not-found view for an unknown :id (still 200, server-resolved)", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/listings/nope");

    expect(await body(response)).toContain("Not found");
  });
});

describe("/lab — deferred (visible) hydration island", () => {
  it("ships the DeferredPanel with a visible-hydration strategy in its mount script", async () => {
    const app = await buildApp();

    const html = await body(await app.handle("GET", "/lab"));

    expect(html).toContain('"component":"DeferredPanel"');
    expect(html).toContain('"strategy":"visible"');
  });
});

describe("/lab/streaming — async server data", () => {
  it("awaits a slow source in load, then renders the resolved listings", async () => {
    const app = await buildApp();

    const html = await body(await app.handle("GET", "/lab/streaming"));

    expect(html).toContain("Async server data");
    expect(html).toContain("Malibu Cliffside");
  });
});

describe("/lab/flags — the feature-flag gate (@lesto/flags)", () => {
  it("404s when the flag is off (the default)", async () => {
    const app = await buildApp();

    expect((await app.handle("GET", "/lab/flags")).status).toBe(404);
  });

  it("renders when ?preview=1 flips the flag on", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/flags", { query: { preview: "1" } });

    expect(response.status).toBe(200);
    expect(await body(response)).toContain("Preview feature");
  });
});

// The viewer demo account — read-only; lacks the admin role the page requires.
const GUEST = DEMO_ACCOUNTS.find((d) => d.id === "guest")!;

// A same-origin form post — what the originCheck on `/mls/api/sign-in` lets through.
const SAME_ORIGIN = {
  "content-type": "application/x-www-form-urlencoded",
  "sec-fetch-site": "same-origin",
};

/**
 * Sign in as a demo account through the REAL `/mls` flow (Identity.login), and
 * return the `name=value` session cookie to replay on a subsequent request — the
 * same cookie a browser would carry. This is what replaced the `?role=` knob: the
 * lab's admin gate reads its principal from this very session.
 */
async function signInCookie(
  app: Awaited<ReturnType<typeof buildApp>>,
  account: DemoAccount,
): Promise<string> {
  const res = await app.handle("POST", "/mls/api/sign-in", {
    headers: SAME_ORIGIN,
    body: new URLSearchParams({ email: account.email, password: account.password }).toString(),
  });

  expect(res.status).toBe(303);

  const setCookie = res.headers["Set-Cookie"]!;
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie;

  return header.split(";")[0]!;
}

describe("/lab/admin — the authorization gate (@lesto/authz, deny-by-default)", () => {
  it("denies an unauthenticated visitor (403)", async () => {
    const app = await buildApp();

    expect((await app.handle("GET", "/lab/admin")).status).toBe(403);
  });

  it("denies a signed-in viewer who lacks the admin role (403)", async () => {
    const app = await buildApp();
    const cookie = await signInCookie(app, GUEST);

    expect((await app.handle("GET", "/lab/admin", { headers: { cookie } })).status).toBe(403);
  });

  it("allows a signed-in admin (200) — the session, not a ?role= knob, decides", async () => {
    const app = await buildApp();
    const cookie = await signInCookie(app, DEFAULT_DEMO);

    const response = await app.handle("GET", "/lab/admin", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await body(response)).toContain("Admin only");
  });
});

describe("/lab/content/:slug — DB-driven (WordPress-style) pages", () => {
  it("loads a block tree from the database and renders it through the Registry", async () => {
    const app = await buildApp();

    const html = await body(await app.handle("GET", "/lab/content/welcome"));

    expect(html).toContain("This page is data, not code.");
    expect(html).toContain("Rendered from a serialized block tree");
  });

  it("renders a not-found view for an unknown slug", async () => {
    const app = await buildApp();

    expect(await body(await app.handle("GET", "/lab/content/nope"))).toContain("Not found");
  });
});

describe("/lab/api/listings/:id — the CSR island's data route", () => {
  it("answers JSON for a real id", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/api/listings/malibu-cliff");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      id: "malibu-cliff",
      title: "Malibu Cliffside",
    });
  });

  it("404s an unknown id", async () => {
    const app = await buildApp();

    expect((await app.handle("GET", "/lab/api/listings/nope")).status).toBe(404);
  });
});

describe("typed server mutation (ADR 0022) — the SaveNote island's endpoint", () => {
  it("renders the SaveNote island in the lab index", async () => {
    const app = await buildApp();

    const html = await body(await app.handle("GET", "/lab"));

    expect(html).toContain('"component":"SaveNote"');
  });

  it("mints a double-submit CSRF token from /lab/api/csrf", async () => {
    const app = await buildApp();

    const token = await csrfToken(app);

    // A signed token is `<nonce>.<hmac>` — two non-empty halves.
    expect(token.split(".").filter((p) => p.length > 0)).toHaveLength(2);
  });

  it("403s a mutation called with NO CSRF token (fail-closed)", async () => {
    const app = await buildApp();

    const response = await callMutation(app, "saveListingNote", {
      listingId: "malibu-cliff",
      note: "A quiet seller.",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: { code: "MUTATION_CSRF_FAILED", message: "CSRF check failed for this mutation." },
    });
  });

  it("dispatches a valid, CSRF-cleared call and returns the typed success arm", async () => {
    const app = await buildApp();
    const token = await csrfToken(app);

    const response = await callMutation(
      app,
      "saveListingNote",
      { listingId: "malibu-cliff", note: "A quiet seller." },
      token,
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      data: {
        saved: {
          listingId: "malibu-cliff",
          note: "A quiet seller.",
          savedAt: "2026-06-18T00:00:00.000Z",
        },
      },
    });
  });

  it("takes the typed ERROR path for the `boom` sentinel note (422 LAB_NOTE_REJECTED)", async () => {
    const app = await buildApp();
    const token = await csrfToken(app);

    const response = await callMutation(
      app,
      "saveListingNote",
      { listingId: "malibu-cliff", note: "boom" },
      token,
    );

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: { code: "LAB_NOTE_REJECTED", message: "That note was rejected on purpose." },
    });
  });

  it("422s a Zod-invalid input (empty note) — boundary validation (ADR 0005)", async () => {
    const app = await buildApp();
    const token = await csrfToken(app);

    const response = await callMutation(
      app,
      "saveListingNote",
      { listingId: "malibu-cliff", note: "" },
      token,
    );

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body).error.code).toBe("MUTATION_INVALID_INPUT");
  });

  it("404s an unknown mutation name", async () => {
    const app = await buildApp();
    const token = await csrfToken(app);

    const response = await callMutation(app, "nope", {}, token);

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("MUTATION_NOT_FOUND");
  });
});
