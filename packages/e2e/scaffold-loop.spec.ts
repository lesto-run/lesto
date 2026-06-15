import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * The scaffold→run loop, end to end — the gate that makes blocker #9's three
 * silent breaks un-shippable (`docs/plans/operability-dx.md` item 2).
 *
 * It exercises the first five minutes of every Keel user:
 *
 *   create-keel <app>  →  keel build  →  keel dev  →  GET /  →  the island hydrates
 *
 * 1. `create-keel`'s own bin scaffolds a fresh app into a temp dir (the `file:`
 *    pins point at the in-repo workspace packages — the unpublished-package
 *    story; at the `0.x` publish they flip to a real version range).
 * 2. `keel build` produces the Preact island client (`out/client.js`) — a build
 *    that used to crash on a missing `out/` dir, and on the absent `keel.sites.ts`
 *    the scaffold now ships.
 * 3. `keel dev` boots and serves the page; we assert on the raw server HTML that
 *    the island shipped its fallback + co-located mount script + the client module
 *    tag, and that `/client.js` is the PREACT bundle (no `react-dom/server`).
 * 4. In a real browser the deferred island mounts and its `useState` button goes
 *    live — a click increments the count, the visible proof hydration ran on the
 *    Preact runtime, not just that the server painted markup.
 *
 * The packages are not published, so a `bun install` of the `file:`-pinned
 * workspace packages cannot resolve their transitive `workspace:*` deps until the
 * publish. So this e2e installs the way a published `bun install` WOULD resolve —
 * by linking the scaffolded app's `node_modules` at the repo's already-installed
 * workspace `node_modules` (where every `@keel/*` package + `react`/`preact` is
 * present) — then runs the in-repo `keel` bin. That makes the app's own
 * `import "@keel/db"` resolve exactly as a published install would. At the `0.x`
 * publish the link step becomes a literal `bun install` (the `file:` pins flip to
 * `^0.x` ranges); everything downstream of it is unchanged.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREATE_KEEL_BIN = join(REPO_ROOT, "packages", "create-keel", "src", "bin.ts");
const KEEL_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");

const PORT = 4188;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const APP_NAME = "scaffold-loop-app";

// Serial + one worker: the suite scaffolds once and shares a single `keel dev`
// process across its tests (parallel workers would each re-scaffold and fight for
// the same port). `beforeAll`/`afterAll` then bracket the whole suite.
test.describe.configure({ mode: "serial" });

let workspace: string;
let appDir: string;
let dev: ChildProcess | undefined;

/** Run a command to completion, rejecting on a non-zero exit. */
function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();

        return;
      }

      reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

/** Poll the dev server until it answers, or time out. */
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

test.beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "keel-scaffold-loop-"));
  appDir = join(workspace, APP_NAME);

  // 1. Scaffold a fresh app via create-keel's own bin.
  await run("bun", [CREATE_KEEL_BIN, APP_NAME], workspace);

  // 2. "Install" the workspace-linked packages: link the app's node_modules at the
  //    repo's installed workspace node_modules (the publish-equivalent of `bun
  //    install` while the packages are unpublished — see the file header).
  await symlink(join(REPO_ROOT, "node_modules"), join(appDir, "node_modules"), "dir");

  // 3. Build the Preact island client (and prove the build no longer crashes on a
  //    fresh out dir / the now-present sites file).
  await run("bun", [KEEL_BIN, "build"], appDir);

  // 4. Boot `keel dev` against the scaffolded app on a private port.
  dev = spawn("bun", [KEEL_BIN, "dev", "--port", String(PORT)], { cwd: appDir, stdio: "pipe" });

  await waitForServer(`${BASE_URL}/`, 30_000);
});

test.afterAll(async () => {
  dev?.kill("SIGTERM");

  await rm(workspace, { recursive: true, force: true });
});

test("the scaffolded page ships the island fallback + mount script + client tag", async ({
  request,
}) => {
  const html = await (
    await request.get(`${BASE_URL}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();

  // The island's server footprint: its marked wrapper, the deferred fallback, and
  // the co-located mount script naming the Counter island.
  expect(html).toContain("data-keel-island");
  expect(html).toContain('data-testid="counter"');
  expect(html).toContain('"component":"Counter"');

  // The hydration runtime is wired: the head module tag that boots /client.js.
  expect(html).toContain('<script type="module" src="/client.js">');
});

test("the served client.js is the Preact bundle, never react-dom/server", async ({ request }) => {
  const response = await request.get(`${BASE_URL}/client.js`);

  expect(response.status()).toBe(200);

  const source = await response.text();

  // The headline of blocker #8: the client never drags React's server renderer.
  expect(source).not.toContain("renderToReadableStream");
  expect(source).not.toContain("renderToStaticMarkup");
});

test("the deferred island hydrates in a real browser — the button goes live", async ({ page }) => {
  await page.goto(`${BASE_URL}/`);

  const counter = page.locator('[data-testid="counter"]');

  await expect(counter).toHaveText("count: 0");

  // A click increments only AFTER hydration — the visible proof the Preact client
  // mounted the live component over the server fallback.
  await counter.click();

  await expect(counter).toHaveText("count: 1");
});
