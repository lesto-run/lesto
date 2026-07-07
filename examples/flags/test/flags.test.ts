/**
 * The @lesto/flags journey, driven through the app over `app.handle`.
 *
 * Every assertion is a claim only an end-to-end wiring can prove: a gated route
 * EXISTS or does not (200 vs 404) depending on the flag, and a `resolve` lever
 * flips that. Each flip asserts BOTH arms — the 404 with the flag off AND the 200
 * with the lever on — so the test is non-vacuous: were the gate bypassed (handler
 * always runs) the off-arm's `toBe(404)` fails; were it always-closed the on-arm's
 * `toBe(200)` fails. Neither arm passes regardless of the flag.
 */

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app";

type App = ReturnType<typeof buildApp>["app"];
type Opts = { query?: Record<string, string>; headers?: Record<string, string> };

/** GET a path through the app and return its status. */
async function status(app: App, path: string, opts?: Opts): Promise<number> {
  return (await app.handle("GET", path, opts ?? {})).status;
}

/** GET a path and parse its JSON body. */
async function json(app: App, path: string, opts?: Opts): Promise<Record<string, unknown>> {
  const res = await app.handle("GET", path, opts ?? {});

  return JSON.parse(res.body) as Record<string, unknown>;
}

describe("GET /dashboard — gated on an OFF-by-default flag (new-dashboard)", () => {
  it("404s when the flag is off (the feature does not exist to a client)", async () => {
    const { app } = buildApp();

    const res = await app.handle("GET", "/dashboard");

    expect(res.status).toBe(404);
    // The default onDisabled is a plain 404 — no hint the route exists.
    expect(res.body).toBe("Not Found");
  });

  it("200s with content when ?preview=1 flips it on (the QA/preview lever)", async () => {
    const { app } = buildApp();

    const res = await app.handle("GET", "/dashboard", { query: { preview: "1" } });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ feature: "new-dashboard" });
  });

  it("200s for a beta-tier principal — per-request targeting (dynamic beats static)", async () => {
    const { app } = buildApp();

    expect(await status(app, "/dashboard", { headers: { "x-user-tier": "beta" } })).toBe(200);
    // A non-beta tier is NOT targeted — the static default (off) still wins ⇒ 404.
    expect(await status(app, "/dashboard", { headers: { "x-user-tier": "free" } })).toBe(404);
  });
});

describe("GET /changelog — gated on an ON-by-default flag (public-changelog)", () => {
  it("200s for everyone by default (a shipped feature)", async () => {
    const { app } = buildApp();

    const res = await app.handle("GET", "/changelog");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ feature: "public-changelog" });
  });

  it("404s under the request-time kill switch — dynamic `false` overrides static `true`", async () => {
    const { app } = buildApp();

    expect(await status(app, "/changelog", { headers: { "x-kill-changelog": "1" } })).toBe(404);
  });
});

describe("GET /experiment — gated on an UNDECLARED flag (unlaunched-experiment)", () => {
  it("404s always — an unknown flag is off, and the preview lever does not leak to it", async () => {
    const { app } = buildApp();

    expect(await status(app, "/experiment")).toBe(404);
    // ?preview=1 only opts into new-dashboard/beta, never an undeclared flag.
    expect(await status(app, "/experiment", { query: { preview: "1" } })).toBe(404);
  });
});

describe("GET /beta/* — a whole subtree gated by one .use(gate('beta'))", () => {
  it("404s every route beneath it when off, and opens them all together when flipped", async () => {
    const { app } = buildApp();

    // Off: BOTH routes under the subtree are absent.
    expect(await status(app, "/beta/labs")).toBe(404);
    expect(await status(app, "/beta/labs/settings")).toBe(404);

    // Flipped: the whole area appears from the single subtree gate.
    expect(await status(app, "/beta/labs", { query: { preview: "1" } })).toBe(200);
    expect(await status(app, "/beta/labs/settings", { query: { preview: "1" } })).toBe(200);
  });
});

describe("GET /flags — the per-request resolution table (dynamic-then-static)", () => {
  it("with no lever, reflects the static defaults (and unknown ⇒ off)", async () => {
    const { app } = buildApp();

    expect(await json(app, "/flags")).toEqual({
      "new-dashboard": false,
      "public-changelog": true,
      beta: false,
      "unlaunched-experiment": false,
    });
  });

  it("with ?preview=1, flips new-dashboard + beta on — and nothing else", async () => {
    const { app } = buildApp();

    expect(await json(app, "/flags", { query: { preview: "1" } })).toEqual({
      "new-dashboard": true,
      "public-changelog": true,
      beta: true,
      "unlaunched-experiment": false,
    });
  });

  it("targets ONLY new-dashboard for a beta-tier principal", async () => {
    const { app } = buildApp();

    expect(await json(app, "/flags", { headers: { "x-user-tier": "beta" } })).toEqual({
      "new-dashboard": true,
      "public-changelog": true,
      beta: false,
      "unlaunched-experiment": false,
    });
  });

  it("lets the kill switch turn public-changelog off — dynamic overriding static", async () => {
    const { app } = buildApp();

    expect(await json(app, "/flags", { headers: { "x-kill-changelog": "1" } })).toEqual({
      "new-dashboard": false,
      "public-changelog": false,
      beta: false,
      "unlaunched-experiment": false,
    });
  });
});
