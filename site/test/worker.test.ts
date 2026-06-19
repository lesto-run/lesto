/**
 * The edge Worker serves assets first and 404s a miss.
 *
 * Drives the real `worker.fetch` with a fake `ASSETS` binding to prove the
 * `withAssets` composition: a hit is returned as-is, a miss falls through to the
 * framework-hardened 404, and a non-GET skips assets entirely (the guard that
 * keeps a write from being swallowed by the static layer).
 */

import { describe, expect, it } from "vitest";

import worker from "../worker";

const ctx = { waitUntil: () => {} };

/** An `ASSETS` binding that answers every request with the given status/body. */
function assets(status: number, body = ""): { fetch: (request: Request) => Promise<Response> } {
  return { fetch: async () => new Response(body, { status }) };
}

describe("worker", () => {
  it("returns a static asset hit unchanged", async () => {
    const response = await worker.fetch(
      new Request("https://docs.lesto.run/quickstart"),
      { ASSETS: assets(200, "<html>prerendered</html>") },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("prerendered");
  });

  it("renders the 404 page when no asset matches", async () => {
    const response = await worker.fetch(
      new Request("https://docs.lesto.run/nope"),
      { ASSETS: assets(404) },
      ctx,
    );

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("404");
    expect(html).toContain("documentation home");
  });

  it("carries the framework's default security headers on the 404", async () => {
    const response = await worker.fetch(
      new Request("https://docs.lesto.run/nope"),
      { ASSETS: assets(404) },
      ctx,
    );

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends a non-GET straight to the app, never the asset layer", async () => {
    // Assets would answer 200, but a POST must not be served a static file.
    const response = await worker.fetch(
      new Request("https://docs.lesto.run/quickstart", { method: "POST" }),
      { ASSETS: assets(200, "<html>prerendered</html>") },
      ctx,
    );

    expect(response.status).toBe(404);
  });
});
