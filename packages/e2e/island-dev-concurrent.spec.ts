import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Two concurrent `lesto dev` apps both keep island Fast Refresh — the regression gate
 * for the per-`lesto dev` free-port fix (DX-parity R2, `L-40a57050`), and the guard that
 * lets island Fast Refresh be the SCAFFOLD DEFAULT without a footgun.
 *
 * island-dev's Vite HTTP + HMR sockets used to bind FIXED ports (24677/24678), so a
 * second concurrent `lesto dev` failed to bind them — `strictPort` rejected and the CLI
 * silently degraded that app to full reload (no Fast Refresh). That is fine for an opt-in
 * feature, but as the universal default it would regress every multi-app dev workflow.
 * The CLI now picks a FREE pair per `lesto dev` (`findIslandDevPorts` in `bin.ts`), so two
 * apps never collide.
 *
 * The proof: boot the SAME tracked `examples/island-fast-refresh` app (which DECLARES the
 * `@lesto/island-dev` peer) TWICE on two different app ports, and assert BOTH serve the
 * island through Vite (`/@lesto-dev/client.js`) AND hydrate. With the old fixed ports the
 * second app would degrade to the bare Bun `/client.js` and this would fail. No file is
 * edited — this is purely the concurrent-boot collision check (the edit→state-preserved
 * round-trip is `island-fast-refresh.spec.ts`).
 *
 * The app is an in-repo workspace member, so its `@lesto/*` deps already resolve — no
 * scaffold/symlink step. Both processes share one project dir read-only; only their app
 * ports differ. (The fixed live-reload socket on 35729 collides between the two — that is
 * the EXISTING graceful degradation, unrelated to island-dev, and does not affect Vite.)
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

/** Boot `lesto dev` for the example on the given port. */
function bootDev(port: number): ChildProcess {
  return spawn("bun", [LESTO_BIN, "dev", "--port", String(port)], { cwd: APP_DIR, stdio: "pipe" });
}

test.beforeAll(async () => {
  // Start both BEFORE waiting: they must be up at the same time for the collision check to
  // mean anything (a sequential boot+shutdown would free the ports and never collide).
  devA = bootDev(PORT_A);
  devB = bootDev(PORT_B);

  await Promise.all([waitForServer(`${URL_A}/`, 30_000), waitForServer(`${URL_B}/`, 30_000)]);
});

test.afterAll(() => {
  devA?.kill("SIGTERM");
  devB?.kill("SIGTERM");
});

/** Assert an app serves its island through Vite (island-dev active, not degraded) + hydrates. */
async function expectViteFastRefresh(
  url: string,
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  const html = await (
    await request.get(`${url}/`, { headers: { "Sec-Fetch-Site": "same-origin" } })
  ).text();

  // island-dev is live for THIS app: the entry is Vite-base-prefixed, not the bare Bun path.
  expect(html).toContain('src="/@lesto-dev/client.js"');
  expect(html).not.toContain('src="/client.js"');

  await page.goto(`${url}/`);
  const counter = page.locator('[data-testid="counter"]');
  await expect(counter).toHaveText("count: 0");
  await counter.click();
  await expect(counter).toHaveText("count: 1");
}

test("the FIRST concurrent lesto dev serves island Fast Refresh via Vite", async ({
  page,
  request,
}) => {
  await expectViteFastRefresh(URL_A, page, request);
});

test("the SECOND concurrent lesto dev ALSO serves Fast Refresh (no fixed-port collision)", async ({
  page,
  request,
}) => {
  await expectViteFastRefresh(URL_B, page, request);
});
