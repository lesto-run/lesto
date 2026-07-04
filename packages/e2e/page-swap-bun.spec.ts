import type { ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { spawnDev, waitForServer } from "./dev-harness";
import { linkWorkspaceInto } from "./link-workspace";

/**
 * Dev page-swap on the BUN dev path, end to end in a real browser (`L-7dd16878`).
 *
 * The page-swap (`L-109e9329`) installs the page-refresh hook only when the synthesized
 * entry is built with `beacon.dev=true`. That was wired for the island-dev (Vite) entry
 * (the scaffold default) but NOT the Bun `buildClient` fallback — so an app that opted
 * OUT of `@lesto/island-dev` full-reloaded on a route save. `L-7dd16878` threads
 * `mode` into `buildClient` so the Bun dev path passes `dev: true` too. This spec proves
 * it in a browser: on the Bun path (bare `/client.js`, no `/@lesto-dev/`), editing an
 * `app/routes/*` file SWAPS the page in place instead of full-reloading.
 *
 * The sibling `page-swap.spec.ts` proves the same on the Vite path; this is its Bun twin.
 * The de-peer + reconstruct-the-workspace-node_modules pattern mirrors `island-bundler-parity.spec.ts`:
 * the fixture is copied to a temp app whose `package.json` does NOT declare the island-dev
 * peer — the single switch that selects the Bun bundler — and the route file is edited in
 * the COPY (so the tracked example is never touched).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LESTO_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");
const FIXTURE = join(REPO_ROOT, "examples", "island-fast-refresh");

// A port unique across the e2e specs (4188 scaffold-loop, 4189 island-fast-refresh,
// 4194/4195 bundler-parity, 4196/4197 island-dev-concurrent, 4198 page-swap) so a
// `fullyParallel` `playwright test` run never collides on the dev-server bind.
const PORT = 4199;
const BASE_URL = `http://127.0.0.1:${PORT}`;

test.describe.configure({ mode: "serial" });

let workspace: string;
let appDir: string;
let pageFile: string;
let dev: ChildProcess | undefined;

test.beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "lesto-page-swap-bun-"));
  appDir = join(workspace, "bun-app");
  pageFile = join(appDir, "app", "routes", "page.tsx");

  // Copy the fixture SOURCE (no node_modules / build output), reconstruct the workspace
  // node_modules the publish-equivalent way (externals + the rebuilt `@lesto/*` scope, since
  // bun's isolated layout no longer hoists `@lesto/*` to the root — see `link-workspace.ts`),
  // then DROP the island-dev peer so `lesto dev` takes the Bun.build path (bare `/client.js`).
  for (const entry of ["package.json", "tsconfig.json", "lesto.app.ts", "lesto.sites.ts", "app"]) {
    await cp(join(FIXTURE, entry), join(appDir, entry), { recursive: true });
  }
  await linkWorkspaceInto(appDir, REPO_ROOT);

  const pkgPath = join(appDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (pkg.dependencies) delete pkg.dependencies["@lesto/island-dev"];
  if (pkg.devDependencies) delete pkg.devDependencies["@lesto/island-dev"];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  const devProc = spawnDev(LESTO_BIN, appDir, PORT);
  dev = devProc.child;

  await waitForServer(`${BASE_URL}/`, 30_000, { output: devProc.output });
});

test.afterAll(async () => {
  dev?.kill("SIGTERM");

  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

test("editing a route file swaps the page in place on the Bun dev path — new markup, no full reload", async ({
  page,
  request,
}) => {
  // Marker: the Bun path serves the bare client bundle — island-dev did NOT activate, so
  // this exercises `buildClient`'s entry (the one `L-7dd16878` wired the dev flag into).
  const html = await (
    await request.get(`${BASE_URL}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();
  expect(html).toContain('src="/client.js"');
  expect(html).not.toContain("/@lesto-dev/");

  await page.goto(`${BASE_URL}/`);

  // The original heading is server-rendered.
  await expect(page.locator("h1")).toHaveText("Island Fast Refresh");

  // THE HEADLINE: the page-refresh hook is now installed on the BUN dev entry (it was
  // Vite-only before). Wait for it before editing, else the swap could fire before the
  // hook exists and fall back to a full reload (the correct floor, just not the assertion).
  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, unknown>)["__lestoDevRefreshPage"] === "function",
    undefined,
    { timeout: 15_000 },
  );

  // Stamp a realm-scoped marker: a full `location.reload()` builds a NEW window and wipes
  // it; a same-document DOM swap leaves it intact. The reload-vs-swap witness.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)["lestoPageSwapProbe"] = "alive";
  });

  // Edit the COPY's route file heading while `lesto dev` watches it (the tracked fixture
  // is never touched — this app is a temp copy).
  const original = await readFile(pageFile, "utf8");
  const edited = original.replace("Island Fast Refresh", "Island Fast Refresh — edited");
  expect(edited).not.toBe(original);
  await writeFile(pageFile, edited);

  // The new heading appears (the page re-rendered + swapped) ...
  await expect(page.locator("h1")).toHaveText("Island Fast Refresh — edited", { timeout: 15_000 });

  // ... and the marker SURVIVED — so this was a same-document swap, not a full reload.
  const marker = await page.evaluate(
    () => (window as unknown as Record<string, unknown>)["lestoPageSwapProbe"],
  );
  expect(marker).toBe("alive");
});
