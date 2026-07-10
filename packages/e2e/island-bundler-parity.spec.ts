import type { ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { killAndWait, spawnDev, waitForServer } from "./dev-harness";
import { linkWorkspaceInto } from "./link-workspace";

/**
 * Build-vs-dev bundler PARITY smoke (DX-parity R2, `L-56f79043`) — the gate before
 * Vite-dev becomes the scaffold default.
 *
 * Phase 1 ships a real mismatch: islands are served by Vite in dev (`@lesto/island-dev`)
 * and bundled by `Bun.build` for prod (`lesto build`). This SMOKE proves the SAME island
 * source compiles AND hydrates under BOTH bundlers — so a divergence that breaks
 * compilation or hydration on one side (a dialect / JSX-runtime mismatch, a define /
 * resolve break) can't slip through unnoticed once Vite-dev becomes the default.
 *
 * One fixture, two bundlers, by toggling ONE thing: the `examples/island-fast-refresh`
 * app is copied to two temp dirs that differ ONLY in whether `package.json` declares the
 * optional `@lesto/island-dev` peer — the single switch that selects the dev bundler:
 *   - omits it     → `lesto dev` builds islands with `Bun.build` (the SAME bundler
 *                    `lesto build` uses) and serves the bare `/client.js`.
 *   - declares it  → `lesto dev` serves islands through Vite under `/@lesto-dev/…`.
 * Each is booted under the real `lesto` bin (so each really runs its bundler); the same
 * Counter island must hydrate (click 0→1) in both, the markers assert each leg actually
 * used the bundler we intended (no silent fallback), and the Bun bundle is checked to be
 * the Preact client (no `react-dom/server`) so a dialect divergence is caught too.
 *
 * SCOPE — a smoke, not full prod parity: the Bun leg runs `lesto dev`'s Bun path in DEV
 * mode (unminified), because `lesto serve` does not serve `out/` assets (prod static is
 * the Worker/CDN's job), so a minified-prod browser leg isn't reachable via the CLI.
 *
 * Workspace packages are linked the way `scaffold-loop.spec.ts` does (reconstruct each temp
 * app's `node_modules` from the repo — externals plus the rebuilt `@lesto/*` scope, since
 * bun's isolated layout no longer hoists `@lesto/*` to the root; see `link-workspace.ts`).
 * The Vite leg's island-dev now picks FREE Vite/HMR
 * ports per `lesto dev` (no longer the old fixed 24677/24678), so it no longer collides
 * with the other island-dev specs on those ports. The Bun live-reload socket likewise binds
 * a FREE ephemeral port per `lesto dev` (no longer the fixed 35729, `buildLiveReload` in
 * `bin.ts`) — before that fix the two concurrently-booted apps here both dialed 35729, the
 * second was 403'd on a token mismatch against the first app's server, and the resulting
 * reconnect storm intermittently kept the island from hydrating (L-89f8ca04).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LESTO_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");
const FIXTURE = join(REPO_ROOT, "examples", "island-fast-refresh");

const BUN_PORT = 4194;
const VITE_PORT = 4195;
const BUN_URL = `http://127.0.0.1:${BUN_PORT}`;
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;

test.describe.configure({ mode: "serial" });

let workspace: string;
let bunDev: ChildProcess | undefined;
let viteDev: ChildProcess | undefined;

/** Copy the fixture's SOURCE (no node_modules / build output) into a fresh app dir. */
async function copyFixture(dest: string): Promise<void> {
  for (const entry of ["package.json", "tsconfig.json", "lesto.app.ts", "lesto.sites.ts", "app"]) {
    await cp(join(FIXTURE, entry), join(dest, entry), { recursive: true });
  }

  // Reconstruct the workspace node_modules the publish-equivalent way (see file header).
  await linkWorkspaceInto(dest, REPO_ROOT);
}

/** Remove `@lesto/island-dev` from an app's package.json — the switch to the Bun path. */
async function dropIslandDevPeer(appDir: string): Promise<void> {
  const path = join(appDir, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  // Strip from BOTH sections so the switch holds even if the peer is ever declared as a
  // runtime dep rather than a devDep (the gate reads both).
  if (pkg.dependencies) delete pkg.dependencies["@lesto/island-dev"];
  if (pkg.devDependencies) delete pkg.devDependencies["@lesto/island-dev"];

  await writeFile(path, JSON.stringify(pkg, null, 2));
}

test.beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "lesto-bundler-parity-"));

  const bunApp = join(workspace, "bun-app");
  const viteApp = join(workspace, "vite-app");

  await copyFixture(bunApp);
  await copyFixture(viteApp);

  // The ONLY difference: the Bun-path app does not declare the island-dev peer.
  await dropIslandDevPeer(bunApp);

  // Assign each child handle right after its spawn: spawnDev's pre-spawn probe can throw between the
  // two (a squatter on the vite port), and afterAll must still be able to kill an already-booted bun.
  const bun = await spawnDev(LESTO_BIN, bunApp, BUN_PORT, BUN_URL);
  bunDev = bun.child;
  const vite = await spawnDev(LESTO_BIN, viteApp, VITE_PORT, VITE_URL);
  viteDev = vite.child;

  await Promise.all([
    waitForServer(`${BUN_URL}/`, 30_000, bun),
    waitForServer(`${VITE_URL}/`, 30_000, vite),
  ]);
});

test.afterAll(async () => {
  // Await BOTH children's exits (in parallel) so a retry's pre-spawn probe finds both fixed ports free.
  await Promise.all([killAndWait(bunDev), killAndWait(viteDev)]);

  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

test("the Bun-bundled island (lesto dev's Bun.build path) hydrates as a Preact client", async ({
  page,
  request,
}) => {
  // Marker: the Bun path serves the bare client bundle — island-dev did NOT activate.
  const html = await (
    await request.get(`${BUN_URL}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();
  expect(html).toContain('src="/client.js"');
  expect(html).not.toContain("/@lesto-dev/");

  // The Bun bundle is the Preact client — no react-dom/server leaked, so the dialect
  // held (matching the Vite leg). Mirrors scaffold-loop's bundle-dialect guard.
  const bundle = await (await request.get(`${BUN_URL}/client.js`)).text();
  expect(bundle).not.toContain("renderToReadableStream");
  expect(bundle).not.toContain("renderToStaticMarkup");

  await page.goto(`${BUN_URL}/`);
  const counter = page.locator('[data-testid="counter"]');
  await expect(counter).toHaveText("count: 0");
  await counter.click();
  await expect(counter).toHaveText("count: 1");
});

test("the Vite-served island (lesto dev path) hydrates the same source", async ({
  page,
  request,
}) => {
  // Marker: the Vite path serves under the dedicated base — island-dev DID activate.
  const html = await (
    await request.get(`${VITE_URL}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();
  expect(html).toContain('src="/@lesto-dev/client.js"');
  expect(html).not.toContain('src="/client.js"');

  await page.goto(`${VITE_URL}/`);
  const counter = page.locator('[data-testid="counter"]');
  await expect(counter).toHaveText("count: 0");
  await counter.click();
  await expect(counter).toHaveText("count: 1");
});
