/**
 * The example's QA gate: drive the admin journey through the REAL HTTP routes
 * (not the `@keel/admin` service methods directly), the way a browser or `curl`
 * would.
 *
 * It asserts the two capabilities this example exists to prove, plus the error
 * mapping a host has to wire by hand:
 *   - **Pagination + projection** — `?limit=&offset=` pages by the primary key,
 *     and `cost` (a real, writable column left out of the resource `fields`)
 *     never appears on any returned row.
 *   - **The `onMutation` audit hook** — a create / update / destroy each lands
 *     exactly one row in `/admin/audit`, carrying the right `action`, `resource`,
 *     `recordId`, and `actor`. The hook is what links a write to its audit row.
 *   - **Coded errors → status** — an unknown id is 404, a bad body is 422.
 */

import { describe, expect, it } from "vitest";

import { openSqlite } from "@keel/runtime";

import { buildApp } from "../src/app";

/** Parse a JSON response body into a typed object. */
function body<T>(response: { body: unknown }): T {
  return JSON.parse(response.body as string) as T;
}

async function boot(seed = true) {
  const { db: handle, close } = await openSqlite();
  const booted = await buildApp({ handle, seed });

  return { ...booted, close };
}

describe("@keel/admin example — the admin journey over HTTP", () => {
  it("paginates the list by limit + offset and projects away the hidden `cost` column", async () => {
    const { app, seeded, close } = await boot();

    try {
      expect(seeded).toBe(5);

      const page1 = body<{ rows: { id: number }[]; limit: number; offset: number }>(
        await app.handle("GET", "/admin/products", { query: { limit: "2", offset: "0" } }),
      );
      const page2 = body<{ rows: { id: number }[] }>(
        await app.handle("GET", "/admin/products", { query: { limit: "2", offset: "2" } }),
      );
      const page3 = body<{ rows: { id: number }[] }>(
        await app.handle("GET", "/admin/products", { query: { limit: "2", offset: "4" } }),
      );

      // Stable, primary-key-ordered paging — each page is the next slice.
      expect(page1.rows.map((r) => r.id)).toEqual([1, 2]);
      expect(page2.rows.map((r) => r.id)).toEqual([3, 4]);
      expect(page3.rows.map((r) => r.id)).toEqual([5]);
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);

      // Projection: every row is exactly { id, name, price, stock }. The `cost`
      // column is in the table (it was seeded) but never leaves through `list`.
      for (const row of page1.rows) {
        expect(Object.keys(row).toSorted()).toEqual(["id", "name", "price", "stock"]);
        expect(row).not.toHaveProperty("cost");
      }
    } finally {
      close();
    }
  });

  it("defaults to page one (offset 0) when no paging query is given", async () => {
    const { app, close } = await boot();

    try {
      const all = body<{ rows: { id: number }[]; offset: number }>(
        await app.handle("GET", "/admin/products"),
      );

      expect(all.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
      expect(all.offset).toBe(0);
    } finally {
      close();
    }
  });

  it("tolerates malformed paging and a non-numeric id instead of crashing", async () => {
    const { app, close } = await boot();

    try {
      // A garbage `?limit=` must fall back to the default page — not reach the
      // query as `NaN`, which SQLite rejects with `no such column: NaN`.
      const listed = await app.handle("GET", "/admin/products", {
        query: { limit: "abc", offset: "xyz" },
      });
      expect(listed.status).toBe(200);
      expect(body<{ rows: unknown[] }>(listed).rows).toHaveLength(5);

      // A non-numeric id resolves to a clean 404, never a NaN-bound query.
      const got = await app.handle("GET", "/admin/products/not-a-number");
      expect(got.status).toBe(404);
      expect(body<{ error: string }>(got).error).toBe("ADMIN_RECORD_NOT_FOUND");
    } finally {
      close();
    }
  });

  it("create / update / destroy each fire the onMutation hook into the audit trail", async () => {
    // Start empty so the only audit rows are the ones this test produces.
    const { app, close } = await boot(false);

    try {
      // 1. Create — fires the hook with action "create".
      const created = await app.handle("POST", "/admin/products", {
        headers: { "x-admin-actor": "ada@keel.dev" },
        body: { name: "Galley Apron", price: 3000, stock: 25, cost: 1100 },
      });
      expect(created.status).toBe(201);
      const product = body<{ id: number; name: string }>(created);
      expect(product).toMatchObject({ name: "Galley Apron" });
      // The create response is itself projected — no `cost` leaks back.
      expect(product).not.toHaveProperty("cost");

      // 2. Update — fires the hook with action "update".
      const updated = await app.handle("PATCH", `/admin/products/${product.id}`, {
        headers: { "x-admin-actor": "ada@keel.dev" },
        body: { price: 2700 },
      });
      expect(updated.status).toBe(200);
      // The merged projection reflects the patch over the untouched fields.
      expect(body<{ price: number; stock: number }>(updated)).toMatchObject({
        price: 2700,
        stock: 25,
      });

      // 3. Destroy — fires the hook with action "destroy".
      const destroyed = await app.handle("DELETE", `/admin/products/${product.id}`, {
        headers: { "x-admin-actor": "ada@keel.dev" },
      });
      expect(destroyed.status).toBe(200);
      expect(body<{ deleted: number }>(destroyed)).toEqual({ deleted: product.id });

      // The audit trail: one row per committed write, newest first, each carrying
      // the actor the request supplied and the row id it touched.
      const trail = body<{
        rows: { action: string; resource: string; recordId: string; actor: string }[];
      }>(await app.handle("GET", "/admin/audit"));

      expect(trail.rows.map((r) => r.action)).toEqual(["destroy", "update", "create"]);
      for (const row of trail.rows) {
        expect(row.resource).toBe("products");
        expect(row.recordId).toBe(String(product.id));
        expect(row.actor).toBe("ada@keel.dev");
      }
    } finally {
      close();
    }
  });

  it("attributes an unattributed write to `anonymous` when no actor header is sent", async () => {
    const { app, close } = await boot(false);

    try {
      await app.handle("POST", "/admin/products", {
        body: { name: "Anon Item", price: 100, stock: 1, cost: 50 },
      });

      const trail = body<{ rows: { actor: string }[] }>(await app.handle("GET", "/admin/audit"));
      expect(trail.rows[0]?.actor).toBe("anonymous");
    } finally {
      close();
    }
  });

  it("maps @keel/admin's coded errors to HTTP status (404 not-found, 422 bad body)", async () => {
    const { app, close } = await boot();

    try {
      // ADMIN_RECORD_NOT_FOUND → 404.
      const missing = await app.handle("GET", "/admin/products/9999");
      expect(missing.status).toBe(404);
      expect(body<{ error: string }>(missing).error).toBe("ADMIN_RECORD_NOT_FOUND");

      // A blank name fails the resource's insert schema → 422 at the boundary,
      // before the write — so it never reaches the audit trail.
      const bad = await app.handle("POST", "/admin/products", {
        body: { name: "", price: 1, stock: 1, cost: 1 },
      });
      expect(bad.status).toBe(422);

      const trail = body<{ rows: unknown[] }>(await app.handle("GET", "/admin/audit"));
      expect(trail.rows).toHaveLength(0);
    } finally {
      close();
    }
  });
});
