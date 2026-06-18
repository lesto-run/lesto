/**
 * Serve the admin panel over LIVE HTTP.
 *
 *   bun run examples/admin/serve.ts
 *
 * Where run.ts dispatches the journey in-process, this boots the same app behind
 * a real node:http server (`@volo/runtime`'s `serve`) and stays up so you can
 * drive the admin by hand — paginate the catalog, create / update / delete a
 * product, and watch each write land in the audit trail at `GET /admin/audit`.
 *
 * Drive it (see README):
 *   curl 'localhost:3000/admin/products?limit=2&offset=0'
 *   curl -X POST localhost:3000/admin/products \
 *     -H 'content-type: application/json' -H 'x-admin-actor: ada@volo.dev' \
 *     -d '{"name":"Galley Apron","price":3000,"stock":25,"cost":1100}'
 *   curl localhost:3000/admin/audit
 */

import { openSqlite, serve } from "@volo/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, seeded } = await buildApp({ handle });

  console.log("migrations applied:", app.migrationsApplied);
  console.log(`seeded ${seeded} products`);

  const server = await serve(app, { port: PORT });
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

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down...");
    await server.close();
    close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
