/**
 * The static-assets Worker front door: serve a matching asset, render a hardened
 * 404 on a miss. The 404 carries the framework's default security headers because
 * it routes through `toFetchHandler`, the same as the dynamic edge path.
 */

import { describe, expect, it } from "vitest";

import { staticAssetsWorker, type AssetExecutionContext, type AssetFetcher } from "../src/index";

/** An ASSETS binding that serves `body` for `path` and 404s everything else. */
const assetsServing = (path: string, body: string): AssetFetcher => ({
  fetch: (request: Request) =>
    Promise.resolve(
      new URL(request.url).pathname === path
        ? new Response(body, { status: 200 })
        : new Response("", { status: 404 }),
    ),
});

const ctx: AssetExecutionContext = { waitUntil: () => undefined };

describe("staticAssetsWorker", () => {
  it("serves a matching asset straight from the binding", async () => {
    const worker = staticAssetsWorker({ notFound: () => "<!doctype html>404" });

    const response = await worker.fetch(
      new Request("https://example.com/client.js"),
      { ASSETS: assetsServing("/client.js", "/* bundle */") },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/* bundle */");
  });

  it("renders the 404 body as HTML on an asset miss", async () => {
    const worker = staticAssetsWorker({ notFound: () => "<!doctype html><h1>Not found</h1>" });

    const response = await worker.fetch(
      new Request("https://example.com/missing"),
      { ASSETS: assetsServing("/client.js", "x") },
      ctx,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<!doctype html><h1>Not found</h1>");
  });

  it("hardens the 404 with the framework's default security headers", async () => {
    const worker = staticAssetsWorker({ notFound: () => "nope" });

    const response = await worker.fetch(
      new Request("https://example.com/missing"),
      { ASSETS: assetsServing("/client.js", "x") },
      ctx,
    );

    // `toFetchHandler` applies the default hardening — a static 404 is not exempt.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
