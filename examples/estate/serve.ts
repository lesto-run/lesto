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

import { serve } from "@keel/runtime";

import { buildProductionSite } from "./src/production";

// Running the estate example locally IS the public demo, so default it into demo
// mode (committed fallback secrets + passwordless sign-in) unless the operator
// set their own KEEL_AUTH_SECRET. The deployed Worker (`worker.ts`) never does
// this, so production stays fail-closed on a missing secret.
process.env["KEEL_DEMO"] ??= "1";

const PORT = Number(process.env["PORT"] ?? 3000);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const OUT = fileURLToPath(new URL("./out", import.meta.url));

async function main(): Promise<void> {
  // Prerender + bundle the client + build the front-door dispatch — the same
  // assembly the integration test exercises (src/production.ts).
  const { dispatch, manifest } = await buildProductionSite(OUT, ROOT);

  for (const site of manifest) {
    console.log(`prerendered ${site.site}: ${site.pages.length} pages`);
  }

  // Serve it. The dispatcher is the app's `handle` as far as the runtime cares.
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
