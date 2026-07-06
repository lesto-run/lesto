import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { killAndWait, spawnDev, waitForServer } from "./dev-harness";

/**
 * Island Fast Refresh, end to end in a real browser — the proof the unit/transform
 * tests cannot reach (the build sandbox couldn't bind ports when `@lesto/island-dev`
 * landed, so the live HMR round-trip was never run). It drives the real `lesto dev`
 * against the tracked `examples/island-fast-refresh` app (Preact dialect — the scaffold
 * default, and the `@prefresh/vite` path that was wired but un-exercised):
 *
 *   1. The dev document is served by the Vite island-dev server — the Vite client and
 *      the entry are base-prefixed under `/@lesto-dev/` (the opt-in is live: the example
 *      DECLARES `@lesto/island-dev`), never the bare Bun `/client.js`.
 *   2. The deferred island hydrates (its `useState` button goes live) and the
 *      cross-port HMR WebSocket connects.
 *   3. THE HEADLINE: with the count clicked up, EDITING the island file applies the new
 *      code WITHOUT resetting the count — Fast Refresh, not a full reload (a reload
 *      would re-render the new label from the initial `0`).
 *
 * The app is an in-repo workspace member, so its `@lesto/*` deps (and the island-dev
 * devDep) already resolve — no scaffold/symlink step, unlike `scaffold-loop.spec.ts`.
 * The island file is edited in place and ALWAYS restored in `afterAll`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LESTO_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");
const APP_DIR = join(REPO_ROOT, "examples", "island-fast-refresh");
const ISLAND_FILE = join(APP_DIR, "app", "islands", "counter.tsx");

const PORT = 4189;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Serial + one worker: the suite shares a single `lesto dev` process (and edits one
// source file), so parallel tests would fight over both.
test.describe.configure({ mode: "serial" });

let dev: ChildProcess | undefined;
let originalIsland: string;

test.beforeAll(async () => {
  // Snapshot the island source so the edit test can restore it no matter how it ends.
  originalIsland = await readFile(ISLAND_FILE, "utf8");

  const devProc = await spawnDev(LESTO_BIN, APP_DIR, PORT, BASE_URL);
  dev = devProc.child;

  await waitForServer(`${BASE_URL}/`, 30_000, devProc);
});

test.afterAll(async () => {
  await killAndWait(dev);

  // Always restore the island file, even if a test left it edited.
  if (originalIsland !== undefined) await writeFile(ISLAND_FILE, originalIsland);
});

test("the dev page is served by the Vite island-dev server (not the Bun path)", async ({
  request,
}) => {
  const html = await (
    await request.get(`${BASE_URL}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();

  // island-dev is active (the example opted in): every Vite URL is base-prefixed, and
  // the app's own `<script src="/client.js">` was rewritten to the base. A bare
  // `/client.js` would mean the Bun reload path — the opt-in gate failed.
  expect(html).toContain('src="/@lesto-dev/@vite/client"');
  expect(html).toContain('src="/@lesto-dev/client.js"');
  expect(html).not.toContain('src="/client.js"');

  // The island still ships its server fallback for first paint.
  expect(html).toContain('data-testid="counter"');
});

test("the island hydrates and the HMR WebSocket connects", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));

  await page.goto(`${BASE_URL}/`);

  const counter = page.locator('[data-testid="counter"]');

  await expect(counter).toHaveText("count: 0");

  // A click increments only AFTER hydration — the proof the Preact client mounted live.
  await counter.click();
  await expect(counter).toHaveText("count: 1");

  // The cross-port Vite HMR WebSocket connected (the channel Fast Refresh rides).
  await expect
    .poll(() => logs.some((line) => line.includes("[vite] connected")), {
      timeout: 15_000,
    })
    .toBe(true);
});

test("editing the island applies new code while preserving useState (Fast Refresh)", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/`);

  const counter = page.locator('[data-testid="counter"]');

  // Drive the count up to a non-initial value so a reset would be visible.
  await counter.click();
  await counter.click();
  await counter.click();
  await expect(counter).toHaveText("count: 3");

  // Edit the live component's label. `count: {count}` is unique to the mounted Counter
  // (the fallback renders `count: {start}`), so this changes only what's on screen.
  const edited = originalIsland.replace("count: {count}", "tally: {count}");
  expect(edited).not.toBe(originalIsland);
  await writeFile(ISLAND_FILE, edited);

  // Fast Refresh applies the new label AND keeps the count at 3. A full reload would
  // re-render the new label from the initial 0 ("tally: 0") — so "tally: 3" is the
  // state-preserving proof.
  await expect(counter).toHaveText("tally: 3", { timeout: 15_000 });

  // Still interactive after the refresh.
  await counter.click();
  await expect(counter).toHaveText("tally: 4");
});
