/**
 * A runnable end-to-end demo of the real Lesto stack.
 *
 *   bun run examples/blog/run.ts
 *
 * It boots the app on an in-memory SQLite database (migrations run on boot),
 * seeds a few posts through the typed @lesto/db handle, then dispatches two
 * real requests through the kernel — the HTML page and the JSON API — and
 * prints what comes back.
 *
 * This exercises every package at once: @lesto/db (typed schema + queries),
 * @lesto/migrate (the posts table), @lesto/web (the lesto() app, its .page
 * streaming a plain-React component, and the JSON route), all assembled
 * by @lesto/kernel.
 */

import { openSqlite } from "@lesto/runtime";

import { buildApp } from "./src/app";
import { countPosts, insertPost } from "./src/post";

const seeds = [
  { title: "Hello, Lesto", body: "A batteries-included, AI-native TypeScript framework." },
  { title: "One substrate", body: "The SQL database is the platform; batteries on top." },
  { title: "Agent-native", body: "MCP, CLI, and UI are three surfaces over one core." },
];

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  // Boot: the kernel runs migrations and stands up dispatch; buildApp also
  // wraps the same handle as a typed @lesto/db, which controllers + seeds
  // share.
  const { app, db } = await buildApp(handle);

  console.log("migrations applied:", app.migrationsApplied);

  for (const seed of seeds) {
    await insertPost(db, seed);
  }

  console.log("posts seeded:", await countPosts(db));
  console.log();

  // Dispatch the HTML page. A `.page` streams its document, so the body is a
  // ReadableStream — drain it to a string to print what the browser receives.
  const page = await app.handle("GET", "/posts");

  console.log(`GET /posts -> ${page.status} ${page.headers["content-type"]}`);
  console.log(await new Response(page.body).text());
  console.log();

  // Dispatch the JSON API.
  const api = await app.handle("GET", "/api/posts");

  console.log(`GET /api/posts -> ${api.status} ${api.headers["content-type"]}`);
  console.log(api.body);

  close();
}

await main();
