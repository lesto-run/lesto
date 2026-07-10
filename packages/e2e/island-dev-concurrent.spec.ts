import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { killAndWait, spawnDev, waitForServer } from "./dev-harness";

/**
 * Two concurrent `lesto dev` apps each get their OWN island Fast Refresh server — the
 * regression gate for the per-`lesto dev` free-port fix (DX-parity R2, `L-40a57050`), and
 * the guard that lets island Fast Refresh be the SCAFFOLD DEFAULT without a footgun.
 *
 * island-dev's Vite HTTP + HMR sockets used to bind FIXED ports (24677/24678), so a second
 * concurrent `lesto dev` failed to bind them — `strictPort` rejected and the CLI silently
 * degraded that app to full reload (no Fast Refresh, serving the bare Bun `/client.js`).
 * That is fine for an opt-in feature, but as the universal default it would regress every
 * multi-app dev workflow. The CLI now picks a FREE pair per `lesto dev` (`findIslandDevPorts`
 * in `bin.ts`), so two apps never collide.
 *
 * The proof: boot the SAME tracked `examples/island-fast-refresh` app (which DECLARES the
 * `@lesto/island-dev` peer) TWICE, on two app ports, AT ONCE, and assert BOTH serve the
 * island through Vite — the document's client tag is rewritten to the Vite base
 * (`/@lesto-dev/client.js`) and the Vite client preamble is injected, which the CLI does
 * ONLY when island-dev's Vite server actually started (a failed start degrades to the bare
 * `/client.js`). Under the OLD fixed ports the second app loses the 24677 race → degrades →
 * bare `/client.js` → this fails. So the served HTML is a sufficient, deterministic
 * collision check.
 *
 * SCOPE — this is the no-port-collision concurrency check, NOT a hydration test. The live
 * `useState`/HMR round-trip (which depends on Vite's cold-start dep-optimizer settling, a
 * timing the browser recovers from via reload but a test can race) is proven, reliably and
 * single-server, by `island-fast-refresh.spec.ts`. Driving a browser click here would only
 * re-test hydration while adding that cold-start flake under the doubled CPU load — so this
 * spec stays at the HTTP layer.
 *
 * The app is an in-repo workspace member, so its `@lesto/*` deps already resolve — no
 * scaffold/symlink step. Both processes share one project dir read-only; only their app
 * ports differ. (The live-reload socket now binds a FREE ephemeral port per `lesto dev`
 * — `buildLiveReload` in `bin.ts`, L-89f8ca04 — so it no longer collides between the two
 * either; it used to share the fixed 35729 and degrade the second app's reload channel.)
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LESTO_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");
const APP_DIR = join(REPO_ROOT, "examples", "island-fast-refresh");

const PORT_A = 4196;
const PORT_B = 4197;
const URL_A = `http://127.0.0.1:${PORT_A}`;
const URL_B = `http://127.0.0.1:${PORT_B}`;

test.describe.configure({ mode: "serial" });

let devA: ChildProcess | undefined;
let devB: ChildProcess | undefined;

test.beforeAll(async () => {
  // Start both BEFORE waiting: they must be up at the same time for the collision check to
  // mean anything (a sequential boot+shutdown would free the ports and never collide). The
  // awaits here are only the fast pre-spawn port probes; both children are still spawned before
  // the Promise.all below waits on either.
  const a = await spawnDev(LESTO_BIN, APP_DIR, PORT_A, URL_A);
  devA = a.child;
  const b = await spawnDev(LESTO_BIN, APP_DIR, PORT_B, URL_B);
  devB = b.child;

  await Promise.all([
    waitForServer(`${URL_A}/`, 30_000, a),
    waitForServer(`${URL_B}/`, 30_000, b),
  ]);
});

test.afterAll(async () => {
  // Await BOTH children's exits (in parallel) so a retry's pre-spawn probe finds both fixed ports free.
  await Promise.all([killAndWait(devA), killAndWait(devB)]);
});

/** Assert an app's document is served through island-dev's Vite server (not the degraded Bun path). */
async function expectIslandDevActive(url: string, request: APIRequestContext): Promise<void> {
  const html = await (
    await request.get(`${url}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();

  // island-dev's Vite server is live for THIS app: the Vite client + the island entry are
  // base-prefixed under `/@lesto-dev/` (the CLI only rewrites to the base when the server
  // actually started), and the bare Bun `/client.js` is gone. A bare tag would mean this
  // app lost the port race and degraded — the regression this gate exists to catch.
  expect(html).toContain('src="/@lesto-dev/@vite/client"');
  expect(html).toContain('src="/@lesto-dev/client.js"');
  expect(html).not.toContain('src="/client.js"');
}

test("the FIRST concurrent lesto dev serves the island via its own Vite server", async ({
  request,
}) => {
  await expectIslandDevActive(URL_A, request);
});

test("the SECOND concurrent lesto dev ALSO serves via Vite (no fixed-port collision)", async ({
  request,
}) => {
  await expectIslandDevActive(URL_B, request);
});
