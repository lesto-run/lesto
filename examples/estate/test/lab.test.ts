/**
 * The /lab feature-demo zone, driven through the real node app.
 *
 * One assertion per capability the lab page-set exists to exercise: SSR data
 * fetching with a typed param, shell-first streaming, the feature-flag gate, the
 * deny-by-default authz gate, and the data route the CSR LiveListing island calls.
 */

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
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

describe("/lab/admin — the authorization gate (@lesto/authz, deny-by-default)", () => {
  it("denies the guest role (403)", async () => {
    const app = await buildApp();

    expect((await app.handle("GET", "/lab/admin")).status).toBe(403);
  });

  it("allows the admin role (200)", async () => {
    const app = await buildApp();

    const response = await app.handle("GET", "/lab/admin", { query: { role: "admin" } });

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
