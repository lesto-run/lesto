/**
 * The whole admin journey, in-process, in one run.
 *
 *   bun run examples/admin/run.ts
 *
 * It boots the panel on an in-memory SQLite database, seeds a small catalog,
 * then dispatches the journey through the kernel over the REAL HTTP routes —
 * paginate the list, narrow the projection, create / update / destroy a product,
 * and read back the audit trail the `onMutation` hook wrote. Every line you see
 * printed is a response that came back over `app.handle`, the same path a browser
 * or `curl` would drive against `serve.ts`.
 *
 * What to watch for:
 *   - The list pages by `?limit=&offset=` and each row is `{ id, name, price,
 *     stock }` — `cost` is in the table but never in the projection.
 *   - Each create / update / destroy lands a row in `/admin/audit` with the right
 *     `action`, `resource`, `recordId`, and `actor` (carried via `x-admin-actor`).
 */

import { openSqlite } from "@lesto/runtime";

import { buildApp } from "./src/app";

/** Parse a JSON response body into a typed object. */
function body<T>(response: { body: unknown }): T {
  return JSON.parse(response.body as string) as T;
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, seeded } = await buildApp({ handle });

  console.log("migrations applied:", app.migrationsApplied);
  console.log(`seeded ${seeded} products\n`);

  // 1. List, page one of two (limit 2). Projection hides `cost`.
  const page1 = await app.handle("GET", "/admin/products", { query: { limit: "2", offset: "0" } });
  const p1 = body<{ rows: Record<string, unknown>[]; limit: number; offset: number }>(page1);
  console.log(`GET /admin/products?limit=2&offset=0 -> ${page1.status}`);
  console.log(`  page 1 (limit ${p1.limit}, offset ${p1.offset}):`, p1.rows);

  // 2. List, page two — offset 2.
  const page2 = await app.handle("GET", "/admin/products", { query: { limit: "2", offset: "2" } });
  const p2 = body<{ rows: Record<string, unknown>[] }>(page2);
  console.log(`GET /admin/products?limit=2&offset=2 -> ${page2.status}`);
  console.log("  page 2:", p2.rows);
  console.log(`  (note: no "cost" on any row — projection allow-list at work)\n`);

  // 3. Create — fires the onMutation audit hook.
  const created = await app.handle("POST", "/admin/products", {
    headers: { "x-admin-actor": "ada@lesto.dev" },
    body: { name: "Galley Apron", price: 3000, stock: 25, cost: 1100 },
  });
  const newProduct = body<{ id: number; name: string }>(created);
  console.log(`POST /admin/products -> ${created.status}`, newProduct);

  // 4. Update — fires the hook again.
  const updated = await app.handle("PATCH", `/admin/products/${newProduct.id}`, {
    headers: { "x-admin-actor": "ada@lesto.dev" },
    body: { price: 2700, stock: 30 },
  });
  console.log(`PATCH /admin/products/${newProduct.id} -> ${updated.status}`, body(updated));

  // 5. Destroy — fires the hook a third time.
  const destroyed = await app.handle("DELETE", `/admin/products/${newProduct.id}`, {
    headers: { "x-admin-actor": "ada@lesto.dev" },
  });
  console.log(`DELETE /admin/products/${newProduct.id} -> ${destroyed.status}`, body(destroyed));

  // 6. The audit trail those three writes produced, newest first.
  const audit = await app.handle("GET", "/admin/audit");
  const trail = body<{ rows: Record<string, unknown>[] }>(audit);
  console.log(`\nGET /admin/audit -> ${audit.status}`);
  for (const row of trail.rows) {
    console.log(
      `  [${row["at"]}] ${String(row["actor"])} ${String(row["action"])} ${String(row["resource"])}#${String(row["recordId"])}`,
    );
  }

  console.log(`\naudit trail recorded ${trail.rows.length} mutations.`);

  close();
}

await main();
