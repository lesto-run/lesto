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
import { d1ContentStore, hyperdriveContentStore } from "../src/content";
import { toFetchHandler } from "@lesto/cloudflare";
import type { D1Database, D1PreparedStatement, HyperdriveConnection } from "@lesto/cloudflare";
import type { LestoResponse } from "@lesto/web";

// >= 32 bytes: the secret-strength guard rejects shorter signing secrets.
const SECRET = "edge-lab-secret-0123456789abcdefg";

const ORIGIN = "https://estate.example.com";

// A same-origin browser POST — what the edge originCheck must let through (a
// state-changing request with no origin signal is refused before dispatch).
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** Drain a `.page` body (React streams on the in-process edge app). */
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

/** Rewrite the adapter's Postgres-flavored text (`$n` + Postgres DDL) to SQLite. */
function pgToSqlite(text: string): string {
  return text
    .replace(/\$\d+/g, "?")
    .replace(/\bBIGINT\b/g, "INTEGER")
    .replace(/GENERATED ALWAYS AS IDENTITY/g, "AUTOINCREMENT");
}

/**
 * A fake Hyperdrive postgres connection backed by in-process SQLite — the
 * Hyperdrive wire shape (`query(text, values) => { rows, rowCount }`) over real
 * SQL. The adapter hands it Postgres-flavored text (`$n` placeholders + the
 * Postgres DDL `createTableSql(..., "postgres")` renders), so the double rewrites
 * those back to SQLite (`pgToSqlite`) so better-sqlite3 can run them — exercising
 * the `hyperdriveContentStore` + `hyperdriveToSqlDatabase` path (binding wiring,
 * `postgres` dialect threading, `?`→`$n` round-trip) without a live Postgres.
 */
function fakeHyperdrive(): HyperdriveConnection {
  const raw = new Database(":memory:");

  return {
    query: async (text, values = []) => {
      const sql = pgToSqlite(text);

      // A statement that returns rows (SELECT / RETURNING) vs one that just writes.
      if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
        const rows = raw.prepare(sql).all(...(values as never[]));

        return { rows, rowCount: rows.length };
      }

      const result = raw.prepare(sql).run(...(values as never[]));

      return { rows: [], rowCount: result.changes };
    },
  };
}

describe("the /lab zone on the edge — DB-driven content over Hyperdrive (Postgres)", () => {
  it("renders the stored block tree through the Hyperdrive store", async () => {
    const app = buildEdgeApp(SECRET, { contentStore: hyperdriveContentStore(fakeHyperdrive()) });

    const html = await body(await app.handle("GET", "/lab/content/welcome"));

    expect(html).toContain("This page is data, not code.");
    expect(html).toContain("Rendered from a serialized block tree");
  });

  it("404-views an unknown slug through the Hyperdrive store", async () => {
    const app = buildEdgeApp(SECRET, { contentStore: hyperdriveContentStore(fakeHyperdrive()) });

    expect(await body(await app.handle("GET", "/lab/content/nope"))).toContain("Not found");
  });
});

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
  it("serves async server data, the flag gate, and the data route", async () => {
    const app = buildEdgeApp(SECRET);

    expect(await body(await app.handle("GET", "/lab/streaming"))).toContain("Async server data");

    expect((await app.handle("GET", "/lab/flags")).status).toBe(404);
    expect((await app.handle("GET", "/lab/flags", { query: { preview: "1" } })).status).toBe(200);

    // Deny-by-default: with no signed session, the authz gate refuses.
    expect((await app.handle("GET", "/lab/admin")).status).toBe(403);

    const data = await app.handle("GET", "/lab/api/listings/malibu-cliff");
    expect(JSON.parse(data.body)).toMatchObject({ id: "malibu-cliff", title: "Malibu Cliffside" });
  });

  it("gates /lab/admin on the signed session — the cookie, not a ?role= knob, decides", async () => {
    // Drive the EXACT Worker fetch handler: an origin-checked POST mints a signed
    // cookie (demo sign-in), which the lab's principal resolver reads back as the
    // admin's session — exactly as a browser would carry it across requests.
    const app = buildEdgeApp(SECRET, { demo: true });
    const handler = toFetchHandler((method, path, options) => app.handle(method, path, options));

    // Signed out: deny-by-default.
    expect((await handler(new Request(`${ORIGIN}/lab/admin`))).status).toBe(403);

    // Sign in as jade (the admin), then replay the signed cookie on the gate.
    const signIn = await handler(
      new Request(`${ORIGIN}/mls/api/sign-in?as=jade`, { method: "POST", headers: SAME_ORIGIN }),
    );
    expect(signIn.status).toBe(303);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const admin = await handler(new Request(`${ORIGIN}/lab/admin`, { headers: { cookie } }));
    expect(admin.status).toBe(200);
  });
});
