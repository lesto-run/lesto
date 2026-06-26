import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

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
 * SCOPE: this proves the page swapped in place (no reload). It does NOT assert island
 * state survives — the page swap is full-body today, so islands re-mount; the
 * layout-preserving partial swap that would keep them is the deferred half (it needs the
 * server to emit `data-lesto-layout` + scoped re-hydration — see softnav.ts's
 * `enableDevPageRefresh`). A page is server-rendered, so there is no client state the
 * reload-vs-swap distinction must protect here; the win is purely avoiding the reload.
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
  originalPage = await readFile(PAGE_FILE, "utf8");

  dev = spawn("bun", [LESTO_BIN, "dev", "--port", String(PORT)], { cwd: APP_DIR, stdio: "pipe" });

  await waitForServer(`${BASE_URL}/`, 30_000);
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
  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, unknown>)["__lestoDevRefreshPage"] === "function",
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
