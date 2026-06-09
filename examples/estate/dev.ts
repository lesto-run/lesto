/**
 * Local development for the whole site set — one origin, instant edits, real
 * island hydration.
 *
 *   bun run examples/estate/dev.ts
 *
 * The contrast with `serve.ts` (the production shape) is the point:
 *   - No prerender. Every zone — static `/` included — renders LIVE through the
 *     app's own `handle` (`dispatchSitesDev`), so editing a page shows on the
 *     next refresh with no build step.
 *   - The island client bundle is built once here (`bun build client.tsx`) and
 *     served at `/client.js`, so the "My Account" island actually hydrates in a
 *     real browser against the same-origin `/mls` session.
 *
 * Open http://127.0.0.1:3000 in a browser: the header shows "Sign in"; visit
 * /mls and sign in; come back to / and the island now greets you — all on one
 * origin, one cookie.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { dispatchSitesDev, nodeStaticReader, serve } from "@keel/runtime";

import { buildApp } from "./src/app";
import sites from "./keel.sites";

const PORT = Number(process.env["PORT"] ?? 3000);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = fileURLToPath(new URL("./out", import.meta.url));

async function main(): Promise<void> {
  // Bundle the island hydration entry to out/client.js. Spawned (not the Bun.build
  // API) so this file stays plain node-typed; the example runs under bun, which
  // provides the bundler.
  execFileSync(
    "bun",
    ["build", "client.tsx", "--outfile", "out/client.js", "--target", "browser"],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );

  const app = buildApp();
  const handle = app.handle.bind(app);

  // Every zone renders live; /client.js (and any .js/.css) is served from out/.
  const dispatch = dispatchSitesDev({ sites, handle, readAsset: nodeStaticReader(ASSETS) });

  const server = await serve({ handle: dispatch, migrationsApplied: [] }, { port: PORT });

  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\ndev server on ${url}`);
  console.log(`  ${url}/         marketing, rendered live (island hydrates via /client.js)`);
  console.log(`  ${url}/mls      the dynamic, authed app`);

  const shutdown = async (): Promise<void> => {
    await server.close();

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
