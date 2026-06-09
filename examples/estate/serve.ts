/**
 * Run the whole site set over LIVE HTTP — both zones, one origin.
 *
 *   bun run examples/estate/serve.ts
 *
 * Three steps, the real pipeline:
 *   1. Prerender the static marketing site to `out/` (`buildStaticSites` — it
 *      fails loudly on any page the app can't render, before writing a thing).
 *   2. Build the path front door (`dispatchSites`): `/` and `/about` come off
 *      the prerendered files; `/mls/*` is the live app. One origin, so the
 *      session cookie set by `/mls` is seen by the static pages too.
 *   3. Stand a node:http server in front of it all.
 *
 * Then:
 *   curl -i http://127.0.0.1:3000/                         # static marketing HTML (+ island manifest)
 *   curl -i http://127.0.0.1:3000/mls/api/session          # 401, nobody signed in
 *   curl -i -X POST http://127.0.0.1:3000/mls/api/sign-in  # 303 + Set-Cookie (survives the path mount)
 *   curl -i -b "keel_session=<token>" .../mls/api/session  # 200 { user } — same-origin session
 */

import { fileURLToPath } from "node:url";

import { dispatchSites, nodeStaticReader, serve } from "@keel/runtime";
import { buildStaticSites, nodeSink } from "@keel/sites";

import { buildApp } from "./src/app";
import sites from "./keel.sites";

const PORT = Number(process.env["PORT"] ?? 3000);
const OUT = fileURLToPath(new URL("./out", import.meta.url));

async function main(): Promise<void> {
  const app = buildApp();

  // `handle` is the app's request function, bound so it can stand alone as the
  // page renderer (build) and the dynamic delegate (serve).
  const handle = app.handle.bind(app);

  // 1. Prerender the static zone.
  const manifest = await buildStaticSites(sites, handle, nodeSink(OUT));

  for (const site of manifest) {
    console.log(`prerendered ${site.site}: ${site.pages.length} pages`);
  }

  // 2. The front door: static files for static zones, the live app for dynamic.
  const dispatch = dispatchSites({ sites, handle, readStatic: nodeStaticReader(OUT) });

  // 3. Serve it. The dispatcher is the app's `handle` as far as the runtime cares.
  const server = await serve({ handle: dispatch, migrationsApplied: [] }, { port: PORT });

  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  ${url}/         static marketing (with the Account island)`);
  console.log(`  ${url}/mls      the dynamic, authed app`);

  const shutdown = async (): Promise<void> => {
    await server.close();

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
