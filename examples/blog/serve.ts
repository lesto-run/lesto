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
 * The same driver story as `run.ts` holds: under Node we boot on
 * better-sqlite3, and under Bun (whose runtime can't dlopen that native addon)
 * `openDatabase` transparently falls back to the built-in `bun:sqlite`.
 */

import { serve } from "@keel/runtime";

import { Post } from "./src/post";
import { buildApp } from "./src/app";
import { openDatabase } from "./src/database";

const PORT = Number(process.env.PORT ?? 3000);

const seeds = [
  { title: "Hello, Keel", body: "A batteries-included, AI-native TypeScript framework." },
  { title: "One substrate", body: "The SQL database is the platform; batteries on top." },
  { title: "Agent-native", body: "MCP, CLI, and UI are three surfaces over one core." },
];

async function main(): Promise<void> {
  const { db, close } = await openDatabase();

  // Boot: the kernel connects the ORM, runs migrations, and stands up dispatch.
  const app = buildApp(db);

  console.log("migrations applied:", app.migrationsApplied);

  // Seed through the same ORM the kernel connected.
  for (const seed of seeds) {
    Post.create(seed);
  }

  console.log("posts seeded:", Post.count());

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
