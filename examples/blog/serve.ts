/**
 * Serve the blog app over LIVE HTTP.
 *
 *   bun run examples/blog/serve.ts
 *
 * Where `run.ts` dispatches a couple of in-process requests and exits, this
 * boots the very same app behind a real node:http server (`@keel/runtime`'s
 * `serve`), seeds it, and stays up so you can hit it with a browser or curl:
 *
 *   curl http://127.0.0.1:3000/posts        # the SSR HTML page
 *   curl http://127.0.0.1:3000/api/posts    # the JSON API
 *
 * The database is opened with `@keel/runtime`'s `openSqlite`: under Node it
 * boots on better-sqlite3, and under Bun (whose runtime can't dlopen that
 * native addon) it transparently falls back to the built-in `bun:sqlite`.
 */

import { openSqlite, serve } from "@keel/runtime";

import { buildApp } from "./src/app";
import { countPosts, insertPost } from "./src/post";

const PORT = Number(process.env.PORT ?? 3000);

const seeds = [
  { title: "Hello, Keel", body: "A batteries-included, AI-native TypeScript framework." },
  { title: "One substrate", body: "The SQL database is the platform; batteries on top." },
  { title: "Agent-native", body: "MCP, CLI, and UI are three surfaces over one core." },
];

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  // Boot: the kernel runs migrations + stands up dispatch; buildApp also
  // wraps the same handle as a typed @keel/db for controllers + seeds.
  const { app, db } = await buildApp(handle);

  console.log("migrations applied:", app.migrationsApplied);

  for (const seed of seeds) {
    await insertPost(db, seed);
  }

  console.log("posts seeded:", await countPosts(db));

  // Stand a real node:http server in front of the app.
  const server = await serve(app, { port: PORT });

  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  ${url}/posts       (HTML page)`);
  console.log(`  ${url}/api/posts   (JSON API)`);

  // Graceful shutdown: close the socket, then the database.
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
