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
 *   - The island client bundle is built here (`bun build client.tsx`) and
 *     served at `/client.js`, so the "My Account" island actually hydrates in a
 *     real browser against the same-origin `/mls` session.
 *   - A watcher on `src/` and `client.tsx` re-runs the bundle on edit, and a
 *     tiny dev-only wrapper around the dispatcher makes the browser notice:
 *     served HTML gains a script that polls `/__keel/version` and reloads when
 *     the number moves. No HMR engine — a counter, a poll, a reload.
 *
 * Open http://127.0.0.1:3000 in a browser: the header shows "Sign in"; visit
 * /mls and sign in; come back to / and the island now greets you — all on one
 * origin, one cookie.
 */

import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchSitesDev, nodeStaticReader, serve } from "@keel/runtime";

import { buildApp } from "./src/app";
import sites from "./keel.sites";

const PORT = Number(process.env["PORT"] ?? 3000);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = fileURLToPath(new URL("./out", import.meta.url));

/** Bumped on every source change; the browser polls it and reloads on a move. */
let version = 1;

/**
 * Bundle the island hydration entry to out/client.js. Spawned (not the
 * Bun.build API) so this file stays plain node-typed; the example runs under
 * bun, which provides the bundler. A failed rebuild keeps the previous bundle
 * on disk and keeps watching — fix the syntax error and save again.
 */
function bundleClient(): void {
  const started = Date.now();

  try {
    execFileSync(
      "bun",
      ["build", "client.tsx", "--outfile", "out/client.js", "--target", "browser"],
      {
        cwd: ROOT,
        stdio: "inherit",
      },
    );

    console.log(`rebuilt client.js (${Date.now() - started}ms)`);
  } catch {
    console.error("client.js rebuild failed — serving the previous bundle");
  }
}

/**
 * Watch the source and call `onChange` once per burst of edits — a save often
 * fires several fs events, so changes are debounced (~100ms) into one rebuild.
 */
function watchSource(onChange: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fire = (): void => {
    clearTimeout(timer);

    timer = setTimeout(onChange, 100);
  };

  watch(join(ROOT, "src"), { recursive: true }, fire);
  watch(join(ROOT, "client.tsx"), fire);
}

/**
 * The inline script injected into dev HTML: poll `/__keel/version` and reload
 * the page when the number changes. Polling, deliberately — `KeelResponse.body`
 * is a complete string, so there is no stream to push events down.
 */
const POLL_SCRIPT = `<script>(() => {
  let seen;

  setInterval(async () => {
    try {
      const { version } = await (await fetch("/__keel/version")).json();

      if (seen !== undefined && version !== seen) location.reload();

      seen = version;
    } catch {
      /* server restarting — keep polling */
    }
  }, 700);
})()</script>`;

type Dispatch = ReturnType<typeof dispatchSitesDev>;

/**
 * Wrap the dispatcher with the dev reload loop: answer `/__keel/version` with
 * the current counter, and append the poll script to any HTML page served.
 * Pure composition — the dispatcher (and the framework) never know.
 */
function withDevReload(dispatch: Dispatch): Dispatch {
  return async (method, path, options) => {
    if (method === "GET" && path === "/__keel/version") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      };
    }

    const response = await dispatch(method, path, options);

    const contentType = response.headers["content-type"] ?? "";

    if (!contentType.includes("text/html")) return response;

    return { ...response, body: `${response.body}\n${POLL_SCRIPT}` };
  };
}

async function main(): Promise<void> {
  bundleClient();

  // Any edit bumps the version (so open pages reload) and re-bundles the
  // client (pages render live anyway; the island bundle is the build output).
  watchSource(() => {
    version += 1;

    bundleClient();
  });

  const app = buildApp();
  const handle = app.handle.bind(app);

  // Every zone renders live; /client.js (and any .js/.css) is served from out/.
  const dispatch = withDevReload(
    dispatchSitesDev({ sites, handle, readAsset: nodeStaticReader(ASSETS) }),
  );

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
