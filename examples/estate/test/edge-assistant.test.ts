/**
 * The AI concierge on the EDGE (the Cloudflare Worker app) — ADR 0031 Inc 4.
 *
 * The concierge route rides on `buildEdgeApp` too, so the deployed public demo
 * answers with the committed local demo model — zero secrets, no network. This
 * drives it through the real `toFetchHandler` adapter and the stateless
 * signed-token auth: a signed-out caller is refused (401), a signed-in caller's
 * question is answered from the `searchListings` tool. (The edge wires no span
 * seams into the app — it mints spans only at the transport — so the traced
 * in-request agent join is asserted on the node path, `ai-trace.dogfood.test.ts`.)
 */

import { describe, expect, it } from "vitest";

import { buildEdgeApp } from "../src/edge";
import { toFetchHandler } from "@lesto/cloudflare";

const SECRET = "edge-assistant-secret-0123456789abc";

const origin = "https://estate.example.com";

// A same-origin browser POST — the edge originCheck refuses a state-changing
// request that carries no origin signal before it reaches dispatch.
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** The Worker's fetch handler over the edge app (demo mode on → `?as=` sign-in reachable). */
function handlerFor(secret: string): (request: Request) => Promise<Response> {
  const app = buildEdgeApp(secret, { demo: true });

  return toFetchHandler((method, path, options) => app.handle(method, path, options));
}

/** Pull the session cookie's `name=value` out of a `Set-Cookie` header. */
function sessionCookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

describe("the AI concierge on the edge", () => {
  it("refuses the concierge when signed out", async () => {
    const handler = handlerFor(SECRET);

    const response = await handler(
      new Request(`${origin}/mls/api/assistant`, {
        method: "POST",
        headers: { ...SAME_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Show me homes in Malibu" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("answers a signed-in visitor from the live MLS via the search tool", async () => {
    const handler = handlerFor(SECRET);

    const signIn = await handler(
      new Request(`${origin}/mls/api/sign-in?as=jade`, { method: "POST", headers: SAME_ORIGIN }),
    );
    const cookie = sessionCookiePair(signIn.headers.get("set-cookie") ?? "");

    const response = await handler(
      new Request(`${origin}/mls/api/assistant`, {
        method: "POST",
        headers: { ...SAME_ORIGIN, "content-type": "application/json", cookie },
        body: JSON.stringify({ prompt: "Show me homes in Malibu" }),
      }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as { answer: string; steps: string[][] };
    // The agent grounded its reply in the one Malibu listing, via one tool call.
    expect(body.answer).toContain("Malibu Cliffside");
    expect(body.steps).toEqual([["searchListings"]]);
  });
});
