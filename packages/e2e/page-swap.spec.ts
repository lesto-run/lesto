import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { spawnDev, waitForServer } from "./dev-harness";

/**
 * Dev page-swap, end to end in a real browser — the "second half" of HMR (DX-parity R2,
 * `L-109e9329`). Editing an `app/routes/*` file demotes the full `location.reload()` to a
 * server re-render + DOM swap, so the new markup appears WITHOUT a jarring full reload.
 *
 *   1. Boot `lesto dev` on `examples/island-fast-refresh`, load the page, and stamp a
 *      marker on `window` — a value a full document reload would wipe (a new realm) but a
 *      same-document DOM swap keeps.
 *   2. Edit `app/routes/page.tsx` (change the `<h1>`), then assert the NEW heading appears
 *      AND the `window` marker SURVIVES — proving the page re-rendered via the page-swap
 *      hook (`enableDevPageRefresh`), not a full reload.
 *
 * SCOPE: this proves the page swapped in place (no reload). It does NOT assert layout
 * island state survives — this example is a single page-level island with no layout, so
 * the swap re-mounts it (correct: a server-rendered page has no client state the
 * reload-vs-swap distinction must protect here; the win is purely avoiding the reload).
 * The layout-preserving HALF — the server now emits `data-lesto-layout` markers and the
 * swap scopes re-hydration to the swapped subtree, so a page edit keeps an unchanged
 * LAYOUT's island state — is wired and unit-proven (`@lesto/web` render-page emits the
 * marker; `@lesto/ui` softnav scopes the re-hydrate). A live browser demo of layout
 * island survival (a layout-with-island example) is a follow-up.
 *
 * The island file is left untouched; the page file is edited in place and ALWAYS restored
 * in `afterAll`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LESTO_BIN = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");
const APP_DIR = join(REPO_ROOT, "examples", "island-fast-refresh");
const PAGE_FILE = join(APP_DIR, "app", "routes", "page.tsx");

const PORT = 4198;
const BASE_URL = `http://127.0.0.1:${PORT}`;

test.describe.configure({ mode: "serial" });

let dev: ChildProcess | undefined;
let originalPage: string;

test.beforeAll(async () => {
  originalPage = await readFile(PAGE_FILE, "utf8");

  const devProc = spawnDev(LESTO_BIN, APP_DIR, PORT);
  dev = devProc.child;

  await waitForServer(`${BASE_URL}/`, 30_000, { output: devProc.output });
});

test.afterAll(async () => {
  dev?.kill("SIGTERM");

  // Always restore the page file, even if a test left it edited.
  if (originalPage !== undefined) await writeFile(PAGE_FILE, originalPage);
});

test("editing a route file swaps the page in place — new markup, no full reload", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/`);

  // The original heading is server-rendered.
  await expect(page.locator("h1")).toHaveText("Island Fast Refresh");

  // Wait until the dev entry has installed the page-refresh hook (it runs after the
  // initial hydrate). A real edit happens seconds after load — but the test edits at
  // once, so without this the swap could fire before the hook exists and fall back to a
  // full reload (which is the correct floor, just not what this test asserts).
  //
  // Residual (rare) race: the live-reload WebSocket (a SEPARATE injected script) might
  // still be connecting when the route save fires `notifyPageSwap()` — the frame would
  // broadcast to zero sockets and be lost, timing out the heading assertion below. The
  // hook is installed AFTER `/client.js` loads + hydrates, by which point the early-parsed
  // WS script has almost always connected, so the window is tiny; it FAILS CLOSED (a
  // timeout, never a false green) and CI `retries: 1` absorbs it.
  await page.waitForFunction(
    () =>
      typeof (window as unknown as Record<string, unknown>)["__lestoDevRefreshPage"] === "function",
    undefined,
    { timeout: 15_000 },
  );

  // Stamp a realm-scoped marker: a full `location.reload()` builds a NEW window and wipes
  // it; a same-document DOM swap leaves it intact. This is the reload-vs-swap witness.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)["lestoPageSwapProbe"] = "alive";
  });

  // Edit the route file's heading while `lesto dev` watches it.
  const edited = originalPage.replace("Island Fast Refresh", "Island Fast Refresh — edited");
  expect(edited).not.toBe(originalPage);
  await writeFile(PAGE_FILE, edited);

  // The new heading appears (the page re-rendered + swapped) ...
  await expect(page.locator("h1")).toHaveText("Island Fast Refresh — edited", { timeout: 15_000 });

  // ... and the marker SURVIVED — so this was a same-document swap, not a full reload.
  const marker = await page.evaluate(
    () => (window as unknown as Record<string, unknown>)["lestoPageSwapProbe"],
  );
  expect(marker).toBe("alive");
});
