import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { run, spawnDev, waitForServer } from "./dev-harness";
import { linkWorkspaceInto } from "./link-workspace";

/**
 * The scaffold→run loop, end to end — the gate that makes blocker #9's three
 * silent breaks un-shippable (`docs/plans/operability-dx.md` item 2).
 *
 * It exercises the first five minutes of every Lesto user:
 *
 *   create-lesto <app>  →  lesto build  →  lesto dev  →  GET /  →  the island hydrates
 *
 * 1. `create-lesto`'s own bin scaffolds a fresh app into a temp dir (the `file:`
 *    pins point at the in-repo workspace packages — the unpublished-package
 *    story; at the `0.x` publish they flip to a real version range).
 * 2. `lesto build` produces the Preact island client (`out/client.js`) — a build
 *    that used to crash on a missing `out/` dir, and on the absent `lesto.sites.ts`
 *    the scaffold now ships. We read that BUILT artifact off disk and assert it is
 *    the PREACT bundle (no `react-dom/server`): `lesto build` always uses `Bun.build`
 *    for prod regardless of the dev bundler, so the prod client is checked at its
 *    source, not over HTTP (dev now serves islands via Vite — see step 3).
 * 3. `lesto dev` boots and serves the page through the Vite Fast-Refresh server — the
 *    scaffold now declares the `@lesto/island-dev` peer by DEFAULT (DX-parity R2), so
 *    `lesto dev` serves islands via Vite under `/@lesto-dev/` (the document's client
 *    tag is rewritten to the base + the Vite client is injected), NOT the bare Bun
 *    `/client.js`. We assert the island's SSR fallback + that Vite-rewritten tag on
 *    the raw server HTML.
 * 4. In a real browser the deferred island mounts and its `useState` button goes
 *    live — a click increments the count, the visible proof hydration ran on the
 *    Preact runtime, not just that the server painted markup.
 *
 * The packages are not published, so a `bun install` of the `file:`-pinned
 * workspace packages cannot resolve their transitive `workspace:*` deps until the
 * publish. So this e2e installs the way a published `bun install` WOULD resolve —
 * by reconstructing the scaffolded app's `node_modules` from the repo (the externals
 * linked in from the repo root, and the `@lesto/*` scope rebuilt from `packages/*`,
 * since bun's isolated layout no longer hoists `@lesto/*` to the repo root — see
 * `link-workspace.ts`) — then runs the in-repo `lesto` bin. That makes the app's own
 * `import "@lesto/db"` resolve exactly as a published install would. At the `0.x`
 * publish the link step becomes a literal `bun install` (the `file:` pins flip to
 * `^0.x` ranges); everything downstream of it is unchanged.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREATE_LESTO_BIN = join(REPO_ROOT, "packages", "create-lesto", "src", "bin.ts");
const LESTO_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");

const PORT = 4188;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const APP_NAME = "scaffold-loop-app";

// Serial + one worker: the suite scaffolds once and shares a single `lesto dev`
// process across its tests (parallel workers would each re-scaffold and fight for
// the same port). `beforeAll`/`afterAll` then bracket the whole suite.
test.describe.configure({ mode: "serial" });

let workspace: string;
let appDir: string;
let dev: ChildProcess | undefined;

test.beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "lesto-scaffold-loop-"));
  appDir = join(workspace, APP_NAME);

  // 1. Scaffold a fresh app via create-lesto's own bin. `--local` pins the @lesto/*
  //    deps at in-repo `file:` paths (the in-monorepo dev mode) — the default emits
  //    published `^0.x` ranges, which only resolve from the registry post-publish.
  //    `--no-install` because step 2 IS the install: a real `bun install` of `file:`
  //    pins can't resolve their transitive `workspace:*` deps until publish (the
  //    unpublished-package problem this e2e works around — see the file header), and
  //    skipping it leaves `node_modules` absent so the link step below can claim it.
  await run("bun", [CREATE_LESTO_BIN, APP_NAME, "--local", "--no-install"], workspace);

  // 2. "Install" the workspace-linked packages: reconstruct the app's node_modules from
  //    the repo (externals + the rebuilt `@lesto/*` scope — bun's isolated layout no
  //    longer hoists `@lesto/*` to the root, so a bare root symlink would resolve none;
  //    see `link-workspace.ts`). The publish-equivalent of `bun install` while the
  //    packages are unpublished.
  await linkWorkspaceInto(appDir, REPO_ROOT);

  // 3. Build the Preact island client (and prove the build no longer crashes on a
  //    fresh out dir / the now-present sites file).
  await run("bun", [LESTO_BIN, "build"], appDir);

  // 4. Boot `lesto dev` against the scaffolded app on a private port.
  const devProc = spawnDev(LESTO_BIN, appDir, PORT);
  dev = devProc.child;

  await waitForServer(`${BASE_URL}/`, 30_000, { output: devProc.output, hasExited: devProc.hasExited });
});

test.afterAll(async () => {
  dev?.kill("SIGTERM");

  await rm(workspace, { recursive: true, force: true });
});

test("the scaffolded page ships the island fallback + the Vite Fast-Refresh client tag", async ({
  request,
}) => {
  const html = await (
    await request.get(`${BASE_URL}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();

  // The island's server footprint: its marked wrapper, the deferred fallback, and
  // the co-located mount script naming the Counter island.
  expect(html).toContain("data-lesto-island");
  expect(html).toContain('data-testid="counter"');
  expect(html).toContain('"component":"Counter"');

  // island Fast Refresh is the scaffold DEFAULT: the app declares `@lesto/island-dev`,
  // so `lesto dev` serves the entry through Vite (base-prefixed) + injects the Vite
  // client — never the bare Bun `/client.js`. A bare tag would mean the default flip
  // regressed (island-dev failed to activate and the dev server fell back to Bun).
  expect(html).toContain('src="/@lesto-dev/@vite/client"');
  expect(html).toContain('src="/@lesto-dev/client.js"');
  expect(html).not.toContain('src="/client.js"');
});

test("the BUILT out/client.js is the Preact bundle, never react-dom/server", async () => {
  // `lesto build` (step 2) always emits the prod client with `Bun.build` — independent of
  // the dev bundler. Read that artifact off disk (the dev server now serves islands via
  // Vite, so the prod bundle is checked at its source, not over HTTP).
  const source = await readFile(join(appDir, "out", "client.js"), "utf8");

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
