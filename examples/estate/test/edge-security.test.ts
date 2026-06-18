/**
 * Edge security posture — blocker #1 (the edge auth fence).
 *
 * The edge twin (`buildEdgeApp` + `edgeSecret`) must match the node twin's
 * hardening: fail closed on a missing secret, refuse the passwordless `?as=`
 * sign-in outside demo mode, refuse a cross-site state-changing request, and
 * throttle a flood. These tests drive the in-process app (Node ships the same
 * global Request/Response a Worker runs), with env controlled per case.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toFetchHandler } from "@volo/cloudflare";

import { buildEdgeApp, edgeSecret, isDemoMode } from "../src/edge";

// >= 32 bytes: the secret-strength guard rejects shorter signing secrets.
const SECRET = "edge-security-secret-0123456789abc";
const origin = "https://estate.example.com";

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
const CROSS_SITE = { "sec-fetch-site": "cross-site" };

/** Build the Worker fetch handler over the edge app. */
function handlerFor(secret: string, demo: boolean): (request: Request) => Promise<Response> {
  const app = buildEdgeApp(secret, { demo });

  return toFetchHandler((method, path, options) => app.handle(method, path, options));
}

describe("edgeSecret — fail closed (blocker #1)", () => {
  // The global setup enables demo mode; these cases need the production posture,
  // so they manage VOLO_DEMO / SESSION_SECRET themselves and restore after.
  let savedDemo: string | undefined;
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedDemo = process.env["VOLO_DEMO"];
    savedSecret = process.env["SESSION_SECRET"];
  });

  afterEach(() => {
    if (savedDemo === undefined) delete process.env["VOLO_DEMO"];
    else process.env["VOLO_DEMO"] = savedDemo;

    if (savedSecret === undefined) delete process.env["SESSION_SECRET"];
    else process.env["SESSION_SECRET"] = savedSecret;
  });

  it("THROWS when SESSION_SECRET is absent and demo mode is off (refuses to serve)", () => {
    delete process.env["VOLO_DEMO"];
    delete process.env["SESSION_SECRET"];

    expect(() => edgeSecret({})).toThrow(/SESSION_SECRET is not set/);
    expect(() => edgeSecret()).toThrow(/SESSION_SECRET is not set/);
  });

  it("uses the committed demo fallback ONLY under an explicit VOLO_DEMO=1 binding", () => {
    delete process.env["VOLO_DEMO"];
    delete process.env["SESSION_SECRET"];

    expect(isDemoMode({ VOLO_DEMO: "1" })).toBe(true);
    expect(edgeSecret({ VOLO_DEMO: "1" })).toMatch(/^estate-demo-edge-secret/);

    // A non-"1" value is NOT demo mode.
    expect(isDemoMode({ VOLO_DEMO: "true" })).toBe(false);
    expect(() => edgeSecret({ VOLO_DEMO: "true" })).toThrow();
  });

  it("prefers a real SESSION_SECRET over the demo fallback, in any mode", () => {
    expect(edgeSecret({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });

  it("reads VOLO_DEMO from process.env when no env binding carries it", () => {
    delete process.env["SESSION_SECRET"];
    process.env["VOLO_DEMO"] = "1";

    expect(isDemoMode()).toBe(true);
    expect(edgeSecret()).toMatch(/^estate-demo-edge-secret/);
  });
});

describe("edge app — passwordless ?as= is fenced behind demo mode (blocker #1)", () => {
  it("refuses the passwordless sign-in (403) when demo mode is OFF", async () => {
    const handler = handlerFor(SECRET, false);

    const res = await handler(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST", headers: SAME_ORIGIN }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it("permits the passwordless sign-in (303) when demo mode is ON", async () => {
    const handler = handlerFor(SECRET, true);

    const res = await handler(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST", headers: SAME_ORIGIN }),
    );

    expect(res.status).toBe(303);
  });
});

describe("edge app — secureStack on the edge (blocker #1)", () => {
  it("refuses a cross-site sign-in POST (403) before dispatch", async () => {
    const handler = handlerFor(SECRET, true);

    const res = await handler(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST", headers: CROSS_SITE }),
    );

    expect(res.status).toBe(403);
  });

  it("refuses a state-changing POST carrying no origin signal (403)", async () => {
    const handler = handlerFor(SECRET, true);

    const res = await handler(new Request(`${origin}/mls/api/sign-out`, { method: "POST" }));

    expect(res.status).toBe(403);
  });

  it("throttles a flood from one client (429) once the bucket is spent", async () => {
    const handler = handlerFor(SECRET, true);

    // The edge limiter is capacity 60. Fire well past it from one (context-less,
    // shared-bucket) client; at least one request must be shed with a 429.
    const statuses: number[] = [];
    for (let i = 0; i < 80; i += 1) {
      const res = await handler(new Request(`${origin}/mls`));
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });
});
