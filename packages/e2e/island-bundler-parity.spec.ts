import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * Build-vs-dev bundler PARITY smoke (DX-parity R2, `L-56f79043`) — the gate before
 * Vite-dev becomes the scaffold default.
 *
 * Phase 1 ships a real mismatch: islands are served by Vite in dev (`@lesto/island-dev`)
 * and bundled by `Bun.build` in prod (`lesto build`). This proves the SAME island source
 * compiles and HYDRATES under BOTH bundlers — catching a "works in dev, breaks built"
 * divergence (dialect, chunking, define inlining, JSX runtime).
 *
 * One fixture, two bundlers, by toggling ONE thing: the `examples/island-fast-refresh`
 * app is copied to two temp dirs that differ ONLY in whether `package.json` declares the
 * optional `@lesto/island-dev` peer — the single switch that selects the dev bundler:
 *   - declares it  → `lesto dev` runs the Vite island path  (`/@lesto-dev/…`).
 *   - omits it     → `lesto dev` runs the Bun build/serve path (bare `/client.js`).
 * Each is booted under the real `lesto` bin (so each really runs its bundler), and the
 * same Counter island must hydrate identically (a click increments 0→1) in both. The
 * markers also assert each leg actually used the bundler we intended (no silent fallback).
 *
 * Workspace packages are linked the same way `scaffold-loop.spec.ts` does (symlink the
 * repo `node_modules` into each temp app) — the published-install equivalent while the
 * `@lesto/*` packages resolve from the workspace.
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

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const response = await fetch(url, { headers: { "Sec-Fetch-Site": "same-origin" } });

      if (response.ok) return;
    } catch {
      // not up yet
    }

    if (Date.now() > deadline) throw new Error(`dev server never answered at ${url}`);

    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Copy the fixture's SOURCE (no node_modules / build output) into a fresh app dir. */
async function copyFixture(dest: string): Promise<void> {
  for (const entry of ["package.json", "tsconfig.json", "lesto.app.ts", "lesto.sites.ts", "app"]) {
    await cp(join(FIXTURE, entry), join(dest, entry), { recursive: true });
  }

  // Link the workspace packages the publish-equivalent way (see file header).
  await symlink(join(REPO_ROOT, "node_modules"), join(dest, "node_modules"), "dir");
}

/** Remove `@lesto/island-dev` from an app's package.json — the switch to the Bun path. */
async function dropIslandDevPeer(appDir: string): Promise<void> {
  const path = join(appDir, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8")) as {
    devDependencies?: Record<string, string>;
  };

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

  bunDev = spawn("bun", [LESTO_BIN, "dev", "--port", String(BUN_PORT)], {
    cwd: bunApp,
    stdio: "pipe",
  });
  viteDev = spawn("bun", [LESTO_BIN, "dev", "--port", String(VITE_PORT)], {
    cwd: viteApp,
    stdio: "pipe",
  });

  await Promise.all([waitForServer(`${BUN_URL}/`, 30_000), waitForServer(`${VITE_URL}/`, 30_000)]);
});

test.afterAll(async () => {
  bunDev?.kill("SIGTERM");
  viteDev?.kill("SIGTERM");

  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

test("the Bun-bundled island (lesto build path) hydrates", async ({ page, request }) => {
  // Marker: the Bun path serves the bare client bundle — island-dev did NOT activate.
  const html = await (
    await request.get(`${BUN_URL}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();
  expect(html).toContain('src="/client.js"');
  expect(html).not.toContain("/@lesto-dev/");

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
