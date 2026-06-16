/**
 * The /lab feature zone on the EDGE (the Cloudflare Worker app).
 *
 * The lab demos are now registered on `buildEdgeApp` too, so they render on
 * Cloudflare — not just under `bun run serve`. The DB-driven content page runs
 * over a D1 store here; this drives the `d1ContentStore` adapter against an
 * in-process SQLite double (vitest runs on Node) so the D1 SQL path is exercised
 * without a live Cloudflare account.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { buildEdgeApp } from "../src/edge";
import { d1ContentStore } from "../src/content";
import type { D1Database, D1PreparedStatement } from "../src/d1";
import type { KeelResponse } from "@keel/web";

// >= 32 bytes: the secret-strength guard rejects shorter signing secrets.
const SECRET = "edge-lab-secret-0123456789abcdefg";

/** Drain a `.page` body (React streams on the in-process edge app). */
async function body(response: KeelResponse): Promise<string> {
  if (typeof response.body === "string") return response.body;

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let out = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    out += decoder.decode(read.value, { stream: true });
  }

  return out + decoder.decode();
}

/** A fake D1 binding backed by in-process SQLite — the D1 wire shape over real SQL. */
function fakeD1(): D1Database {
  const raw = new Database(":memory:");

  return {
    prepare(sql: string): D1PreparedStatement {
      let bound: unknown[] = [];

      const statement: D1PreparedStatement = {
        bind(...values) {
          bound = values;

          return statement;
        },
        run: async () => {
          const result = raw.prepare(sql).run(...(bound as never[]));

          return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
        },
        first: async <T = unknown>() =>
          (raw.prepare(sql).get(...(bound as never[])) ?? null) as T | null,
        all: async <T = unknown>() => ({
          results: raw.prepare(sql).all(...(bound as never[])) as T[],
        }),
      };

      return statement;
    },
  };
}

describe("the /lab zone on the edge — DB-driven content over D1", () => {
  it("renders the stored block tree through the D1 store", async () => {
    const app = buildEdgeApp(SECRET, { contentStore: d1ContentStore(fakeD1()) });

    const html = await body(await app.handle("GET", "/lab/content/welcome"));

    expect(html).toContain("This page is data, not code.");
    expect(html).toContain("Rendered from a serialized block tree");
  });

  it("404-views an unknown slug through the D1 store", async () => {
    const app = buildEdgeApp(SECRET, { contentStore: d1ContentStore(fakeD1()) });

    expect(await body(await app.handle("GET", "/lab/content/nope"))).toContain("Not found");
  });

  it("renders a configure-D1 view when no store is wired (binding absent)", async () => {
    const app = buildEdgeApp(SECRET);

    const html = await body(await app.handle("GET", "/lab/content/welcome"));

    expect(html).toContain("Cloudflare D1 binding");
  });
});

describe("the /lab zone on the edge — the compute demos", () => {
  it("serves async server data, the flag gate, authz, and the data route", async () => {
    const app = buildEdgeApp(SECRET);

    expect(await body(await app.handle("GET", "/lab/streaming"))).toContain("Async server data");

    expect((await app.handle("GET", "/lab/flags")).status).toBe(404);
    expect((await app.handle("GET", "/lab/flags", { query: { preview: "1" } })).status).toBe(200);

    expect((await app.handle("GET", "/lab/admin")).status).toBe(403);
    expect((await app.handle("GET", "/lab/admin", { query: { role: "admin" } })).status).toBe(200);

    const data = await app.handle("GET", "/lab/api/listings/malibu-cliff");
    expect(JSON.parse(data.body)).toMatchObject({ id: "malibu-cliff", title: "Malibu Cliffside" });
  });
});
