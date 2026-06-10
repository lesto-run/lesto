/**
 * A runnable end-to-end demo of the real Keel stack.
 *
 *   bun run examples/blog/run.ts
 *
 * It boots the app on an in-memory SQLite database (migrations run on boot),
 * seeds a few posts through the typed @keel/db handle, then dispatches two
 * real requests through the kernel — the HTML page and the JSON API — and
 * prints what comes back.
 *
 * This exercises every package at once: @keel/db (typed schema + queries),
 * @keel/migrate (the posts table), @keel/router (resources), @keel/web (the
 * controller + renderTree), @keel/ui (the registry + SSR), all assembled
 * by @keel/kernel.
 */

import { buildApp } from "./src/app";
import { openDatabase } from "./src/database";
import { countPosts, insertPost } from "./src/post";

const seeds = [
  { title: "Hello, Keel", body: "A batteries-included, AI-native TypeScript framework." },
  { title: "One substrate", body: "The SQL database is the platform; batteries on top." },
  { title: "Agent-native", body: "MCP, CLI, and UI are three surfaces over one core." },
];

async function main(): Promise<void> {
  const { db: handle, close } = await openDatabase();

  // Boot: the kernel runs migrations and stands up dispatch; buildApp also
  // wraps the same handle as a typed @keel/db, which controllers + seeds
  // share.
  const { app, db } = buildApp(handle);

  console.log("migrations applied:", app.migrationsApplied);

  for (const seed of seeds) {
    insertPost(db, seed);
  }

  console.log("posts seeded:", countPosts(db));
  console.log();

  // Dispatch the HTML page.
  const page = await app.handle("GET", "/posts");

  console.log(`GET /posts -> ${page.status} ${page.headers["content-type"]}`);
  console.log(page.body);
  console.log();

  // Dispatch the JSON API.
  const api = await app.handle("GET", "/api/posts");

  console.log(`GET /api/posts -> ${api.status} ${api.headers["content-type"]}`);
  console.log(api.body);

  close();
}

await main();
