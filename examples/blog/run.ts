/**
 * A runnable end-to-end demo of the real Keel stack.
 *
 *   bun run examples/blog/run.ts
 *
 * It boots the app on an in-memory SQLite database (migrations run on boot),
 * seeds a few posts through the ORM, then dispatches two real requests through
 * the kernel — the HTML page and the JSON API — and prints what comes back.
 *
 * This exercises every package at once: @keel/orm (Post), @keel/migrate (the
 * posts table), @keel/router (resources), @keel/web (the controller + renderTree),
 * @keel/ui (the registry + SSR), all assembled by @keel/kernel.
 */

import { Post } from "./src/post";
import { buildApp } from "./src/app";
import { openDatabase } from "./src/database";

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
