/**
 * Serve the admin panel over LIVE HTTP.
 *
 *   bun run examples/admin/serve.ts
 *
 * Where run.ts dispatches the journey in-process, this boots the same app behind
 * a real node:http server (`@lesto/runtime`'s `serve`) and stays up so you can
 * drive the admin by hand — paginate the catalog, create / update / delete a
 * product, and watch each write land in the audit trail at `GET /admin/audit`.
 *
 * Drive it (see README):
 *   curl 'localhost:3000/admin/products?limit=2&offset=0'
 *   curl -X POST localhost:3000/admin/products \
 *     -H 'content-type: application/json' -H 'x-admin-actor: ada@lesto.dev' \
 *     -d '{"name":"Galley Apron","price":3000,"stock":25,"cost":1100}'
 *   curl localhost:3000/admin/audit
 */

import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, seeded } = await buildApp({ handle });

  console.log("migrations applied:", app.migrationsApplied);
  console.log(`seeded ${seeded} products`);

  // serveWithGracefulShutdown owns the SIGINT + SIGTERM wiring, the double-signal guard, and a
  // force-exit backstop (see @lesto/runtime): `onShutdown` runs on the signal, before the drain;
  // `onClosed` runs after in-flight requests drain — where the db is safe to close.
  const server = await serveWithGracefulShutdown(app, {
    port: PORT,
    onShutdown: () => console.log("\nshutting down..."),
    onClosed: close,
  });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  GET    ${url}/admin/products?limit=&offset=   (paginated + projected)`);
  console.log(`  GET    ${url}/admin/products/:id`);
  console.log(`  POST   ${url}/admin/products            {"name","price","stock","cost"}`);
  console.log(`  PATCH  ${url}/admin/products/:id`);
  console.log(`  DELETE ${url}/admin/products/:id`);
  console.log(`  GET    ${url}/admin/audit               (the onMutation trail)`);
  console.log(
    `\n  pass  -H 'x-admin-actor: you@example.com'  to attribute a write in the audit log`,
  );
}

await main();
