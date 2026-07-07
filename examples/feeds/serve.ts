/**
 * Serve the blog and its feeds over LIVE HTTP.
 *
 *   bun run examples/feeds/serve.ts
 *
 * Where run.ts drives the journey in-process with `app.handle`, this boots the
 * SAME app behind a real `node:http` server (`@lesto/runtime`'s
 * `serveWithGracefulShutdown`) so an ACTUAL feed reader — or `curl` — can fetch
 * `/feed.xml` and `/atom.xml` over a socket and get the `application/rss+xml` /
 * `application/atom+xml` bytes verbatim.
 *
 * `buildApp` installs the `posts` schema on the handle and seeds it; `createApp`
 * (`@lesto/kernel`) wraps the bare `@lesto/web` app into the bootable kernel `App`
 * a server needs, installing the durable-store schema (sessions/rate-limits) on
 * that SAME handle. So the one database does double duty — the posts the feeds
 * render AND the kernel's own tables — with no throwaway handle. The store is
 * in-memory (seeded fresh on each boot): a feed is a pure projection of the
 * posts, so there is no cross-restart state worth persisting.
 *
 * Drive it:
 *   open http://localhost:3000/            # the index, in a browser
 *   curl localhost:3000/feed.xml           # RSS 2.0
 *   curl localhost:3000/atom.xml           # Atom 1.0
 */

import { createApp } from "@lesto/kernel";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const booted = await buildApp({ handle });
  const app = await createApp({ db: handle, app: booted.app });

  console.log("migrations applied:", app.migrationsApplied);

  const server = await serveWithGracefulShutdown(app, { port: PORT, onClosed: close });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  GET  ${url}/           (open this in a browser)`);
  console.log(`  GET  ${url}/feed.xml   (RSS 2.0)`);
  console.log(`  GET  ${url}/atom.xml   (Atom 1.0)`);
}

await main();
