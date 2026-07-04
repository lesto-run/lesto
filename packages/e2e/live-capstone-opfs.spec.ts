import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { assertPortAvailable, killAndWait, waitForServer } from "./dev-harness";

/**
 * The Tier-4 v1 capstone's headless-browser REGRESSION GATE (ADR 0042, `L-2e410682`) — the CI guard
 * for the browser-only half a Node/bun gate structurally cannot cover.
 *
 * ## Why this exists
 *
 * The capstone's automated acceptance (`examples/live-capstone/test/acceptance.pg.ts`) drives the
 * server/wire half over REAL Postgres logical replication, but it runs in bun, which has no OPFS,
 * no Web Locks, no BroadcastChannel. So the durable-store + cross-tab guarantees were left to a
 * MANUAL browser checklist — and the first real-browser run found a P0 the gate had no way to catch:
 * `openOpfsSqliteDatabase` booted `sqlite3-wasm` + `installOpfsSAHPoolVfs` on the MAIN THREAD, but
 * SAHPool needs `createSyncAccessHandle`, which is `[Exposed=DedicatedWorker]` — Worker-only in every
 * browser. The durable store was DOA in every tab (Inc9, `L-565a4b33`, fixed by hosting the engine in
 * a dedicated Worker). A manual run is confirmation, not a gate; nothing stops that class regressing.
 * This spec boots the REAL built bundle in a REAL Chromium and asserts the durable/offline/cross-tab
 * behaviour end to end — the test that would have caught Inc9 in CI.
 *
 * ## What it drives (the manual checklist in `examples/live-capstone/evidence/README.md`, verbatim)
 *
 *   1. The durable OPFS store OPENS (no `OpfsSqliteError`) and the leader takes the connection.
 *   2. **Durable first paint (the key assertion):** a sent message STILL renders after a reload whose
 *      every server data route is blocked at the network layer — OPFS is then the only possible
 *      source, so the repaint PROVES durability rather than asserting it.
 *   3. An offline write paints optimistically (the leader outbox) and drains to the server on reconnect.
 *   4. A second tab MIRRORS the leader with no connection of its own, and is promoted on the leader's
 *      close (Web-Locks failover) — after which its writes reach the server again.
 *
 * ## Runtime shape
 *
 * Like `page-swap.spec.ts`, this OWNS its server rather than using the shared `webServer`: `beforeAll`
 * builds the capstone client (`bun run build` — the same LITERAL-dynamic-import bundle CI already
 * verifies) and serves it with `bun serve.ts` on the **dev SQLite poll** source (`LESTO_LIVE_SOURCE`
 * unset → no Postgres needed; all four steps live ABOVE the change source, so the poll exercises them
 * exactly as prod would). Each `test()` gets a fresh Playwright context — hence a fresh OPFS — while a
 * `page.reload()` WITHIN a test preserves it, which is precisely the durability boundary under test.
 *
 * GOTCHAS encoded from the proven run: CSS selectors only (`#message-body` / `#messages li`), never the
 * a11y-ref form; assert on the LIST, never the `— N message(s)` status count (a snapshot-timing
 * artifact that can read 0 while the list is correct); the two tabs share ONE context (BroadcastChannel
 * + Web Locks need same-origin same-context). A fully-offline `reload()` is deliberately NOT attempted
 * — no service worker ships the shell, so the DOCUMENT fetch fails offline; step 2 proves data
 * durability airtight by blocking only the DATA routes while letting the shell load.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_DIR = join(REPO_ROOT, "examples", "live-capstone");

// A port of its own — the shared `playwright.config.ts` webServer (the island fixture) still boots on
// 4180, unused here, exactly as it is for `page-swap`; this test only ever talks to its own server.
const PORT = 4187;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const APP_URL = `${BASE_URL}/?user=alice&room=lobby`;

// The leader (and ONLY the leader) opens this stream, and only AFTER its durable store has opened and
// `createLiveMutations` is wired — so a request to it is a deterministic witness that leadership is
// fully established (optimistic writes will now apply). If the OPFS store cannot open, the leader bid
// tears down and this is never requested, so waiting on it ALSO fails the Inc9 class loudly.
const LIVE_DATA = "/__lesto/live-data";
const isLiveData = (url: string): boolean => url.includes(LIVE_DATA);

test.describe.configure({ mode: "serial", timeout: 60_000 });

let server: ChildProcess | undefined;

/** Run the capstone's `vite build` to completion (the built bundle is what the browser exercises). */
async function buildCapstone(): Promise<void> {
  // Inherit stdout (streams vite's output to the run log AND drains it — an unread "pipe" stdout can
  // backpressure-hang a chatty child); collect only stderr for the failure message.
  const build = spawn("bun", ["run", "build"], {
    cwd: APP_DIR,
    stdio: ["ignore", "inherit", "pipe"],
  });

  let stderr = "";

  build.stderr?.on("data", (chunk) => (stderr += String(chunk)));

  // `events.once` attaches its own `error` listener and REJECTS if the child emits `error` before
  // `close` (e.g. `bun` missing), so a spawn failure surfaces loudly here rather than crashing the
  // process; a non-zero/absent exit is reported below with the collected stderr.
  const [code] = (await once(build, "close")) as [number | null];

  if (code !== 0) {
    throw new Error(`capstone \`bun run build\` failed (exit ${String(code)})\n${stderr}`);
  }
}

/** Has the server stored a `messages` row with this exact body? (the authorized READ, room-scoped). */
async function serverHasBody(request: APIRequestContext, body: string): Promise<boolean> {
  const response = await request.get(`${BASE_URL}/messages?room=lobby&user=alice`);
  const payload = (await response.json()) as { messages?: Array<{ body?: unknown }> };

  return (payload.messages ?? []).some((row) => row.body === body);
}

test.beforeAll(async () => {
  // Build + serve can take a moment on a cold CI runner (wasm-carrying bundle); give the hook room.
  test.setTimeout(180_000);

  await buildCapstone();

  // Force the dev poll path deterministically: SOURCE unset defaults to poll, but a stray
  // LESTO_LIVE_PG_URL in the environment would make `resolveSourceConfig` refuse to boot, so strip both.
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
  };

  delete env["LESTO_LIVE_SOURCE"];
  delete env["LESTO_LIVE_PG_URL"];

  // Same live-squatter defense as spawnDev (L-b5186728): if a server leaked by a prior crashed run
  // is already answering this fixed port, adopting it would durably-repaint against STALE state and
  // pass this gate falsely. Probe before spawn so a squatter fails the boot loud.
  await assertPortAvailable(PORT, BASE_URL);

  // Inherit stdio (surfaces serve.ts's logs in the run output AND drains the pipes).
  server = spawn("bun", ["serve.ts"], { cwd: APP_DIR, stdio: "inherit", env });

  let exited = false;

  server.once("exit", () => (exited = true));

  // `hasExited` fails fast if our own `bun serve.ts` child died before answering, rather than
  // silently ADOPTING a stale/foreign server squatting on the fixed port until the deadline.
  await waitForServer(`${BASE_URL}/`, 60_000, { hasExited: () => exited });
});

test.afterAll(async () => {
  await killAndWait(server);
});

test("boots the OPFS-SQLite leader and repaints durably after a data-blocked reload (the Inc9 gate)", async ({
  page,
}) => {
  const nonce = Date.now().toString(36);
  const body = `durable OPFS proof ${nonce}`;

  // The load-bearing Inc9 detector. The leader (and only the leader) opens this stream, and ONLY after
  // its durable store has opened — so awaiting it gates on the store actually opening. Pre-Inc9,
  // `openOpfsSqliteDatabase` rejects in every browser → `createLeaderStore` throws → the leader bid
  // tears down → `connectLiveData` is never called → this request never fires → the await times out RED.
  //
  // NB: there is deliberately NO "assert `OpfsSqliteError` is absent from the console" check here. The
  // app CATCHES an OPFS-open failure and routes it to the `#status` text (main.ts), never
  // `console.error`/`pageerror` — so such an assertion would be green-forever/decorative (the exact
  // vacuous-negative-assertion trap this repo codified). The witness below can genuinely go red;
  // confirmed by a worker-blocked negative control (see this test's commit message).
  const leaderConnected = page.waitForRequest((r) => isLiveData(r.url()), { timeout: 20_000 });

  await page.goto(APP_URL);
  await leaderConnected;

  // Write a row, and confirm it round-tripped to the server (so it is a real synced row, not just an
  // optimistic overlay) before proving durability.
  await page.fill("#message-body", body);
  await page.click("#send-form button");
  await expect(page.locator("#messages li", { hasText: body })).toBeVisible();

  await expect.poll(() => serverHasBody(page.request, body), { timeout: 15_000 }).toBe(true);

  // One more poll cycle (the source polls every 50ms) for the change source to stream the insert back
  // and the leader store to PERSIST it to OPFS before we sever the wire and reload.
  await page.waitForTimeout(1_500);

  // Block every server DATA route (the stream and the mutation/read endpoint) at the network layer,
  // but leave the shell + assets loadable. After the reload the ONLY possible source of a row is the
  // durable OPFS store — so if the message repaints, durability is PROVEN, not asserted.
  await page.route(`**${LIVE_DATA}**`, (route) => route.abort());
  await page.route("**/messages**", (route) => route.abort());

  await page.reload();

  await expect(page.locator("#messages li", { hasText: body })).toBeVisible({ timeout: 20_000 });
});

test("an offline write paints optimistically and drains to the server on reconnect", async ({
  page,
  context,
}) => {
  const nonce = Date.now().toString(36);
  const body = `offline write ${nonce}`;

  // Wait for leadership BEFORE going offline: only the leader holds the durable store + outbox, so
  // only a leader send paints optimistically offline (a follower's offline send fails, by design).
  const leaderConnected = page.waitForRequest((r) => isLiveData(r.url()), { timeout: 20_000 });

  await page.goto(APP_URL);
  await leaderConnected;

  await context.setOffline(true);

  // Offline: the `POST /messages` fails, but the leader shows the write at once from its outbox overlay.
  await page.fill("#message-body", body);
  await page.click("#send-form button");
  await expect(page.locator("#messages li", { hasText: body })).toBeVisible();

  // Back online, then drive the drain the app wires to the `online` event. Dispatching it ourselves is
  // not faking connectivity (the network IS restored) — it just triggers the outbox flush the app
  // performs on reconnect, so the assertion does not hinge on whether the emulator re-fires the event.
  await context.setOffline(false);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));

  // The queued write reconciles onto the server under its client-minted id.
  await expect.poll(() => serverHasBody(page.request, body), { timeout: 20_000 }).toBe(true);
});

test("a second tab mirrors the leader with no connection of its own, and is promoted on failover", async ({
  page,
  context,
}) => {
  const nonce = Date.now().toString(36);
  const mirrored = `cross-tab mirror ${nonce}`;
  const afterFailover = `after failover ${nonce}`;

  // Bring the leader up and put a message on the wire for the follower to mirror.
  const leaderConnected = page.waitForRequest((r) => isLiveData(r.url()), { timeout: 20_000 });

  await page.goto(APP_URL);
  await leaderConnected;

  await page.fill("#message-body", mirrored);
  await page.click("#send-form button");
  await expect(page.locator("#messages li", { hasText: mirrored })).toBeVisible();

  // A SECOND tab in the SAME context (BroadcastChannel + Web Locks are same-origin same-context).
  const follower = await context.newPage();

  let followerOpenedOwnConnection = false;

  follower.on("request", (r) => {
    if (isLiveData(r.url())) followerOpenedOwnConnection = true;
  });

  await follower.goto(APP_URL);

  // The follower mirrors the leader's rendered slice over BroadcastChannel ...
  await expect(follower.locator("#messages li", { hasText: mirrored })).toBeVisible({
    timeout: 20_000,
  });

  // ... and holds NO sync connection of its own — the leader owns the only one (that is exactly why a
  // second tab does not contend for the exclusive OPFS handle and throw).
  expect(
    followerOpenedOwnConnection,
    "a follower must not open its own /__lesto/live-data connection",
  ).toBe(false);

  // FAILOVER: closing the leader tab releases its Web Lock (the browser reclaims it + the OPFS handle
  // with no JS running); the follower's pending bid is granted and it opens the connection.
  const followerPromoted = follower.waitForRequest((r) => isLiveData(r.url()), { timeout: 20_000 });

  await page.close();
  await followerPromoted;

  // The promoted tab resumed the connection + outbox: a send now paints optimistically AND reaches the
  // server — leadership moved, not just the local view.
  await follower.fill("#message-body", afterFailover);
  await follower.click("#send-form button");
  await expect(follower.locator("#messages li", { hasText: afterFailover })).toBeVisible();

  await expect
    .poll(() => serverHasBody(follower.request, afterFailover), { timeout: 20_000 })
    .toBe(true);
});
