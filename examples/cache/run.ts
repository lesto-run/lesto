/**
 * The whole read-through journey, in-process, in one run.
 *
 *   bun run examples/cache/run.ts
 *
 * It boots the app on an in-memory SQLite database with the REAL system clock and
 * a deliberately slow origin, then drives the journey through the actual HTTP
 * routes so you can watch each miss pay the origin cost and each hit skip it:
 * miss → hit → a burst of concurrent misses that coalesce into ONE origin call →
 * invalidate → miss again → sweep.
 */

import { systemClock } from "@lesto/cache";
import { openSqlite } from "@lesto/runtime";

import { buildApp } from "./src/app";

const TTL_MS = 60_000;
const ORIGIN_DELAY_MS = 25;

async function get(app: Awaited<ReturnType<typeof buildApp>>["app"], id: string): Promise<string> {
  const res = await app.handle("GET", `/reports/${id}`);

  return res.body as string;
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, origin } = await buildApp({
    handle,
    clock: systemClock,
    ttlMs: TTL_MS,
    delayMs: ORIGIN_DELAY_MS,
  });

  // 1. Miss — the first read pays the origin cost and caches the value.
  console.log(`GET /reports/alpha -> ${await get(app, "alpha")}   (miss)`);
  console.log(`  origin loads so far: ${origin.loads}\n`);

  // 2. Hit — the same key inside the TTL replays the cached value; `generatedAt`
  //    is identical, and the origin count does not move.
  console.log(`GET /reports/alpha -> ${await get(app, "alpha")}   (hit — same generatedAt)`);
  console.log(`  origin loads so far: ${origin.loads}\n`);

  // 3. Single-flight — five concurrent misses for a cold key share ONE compute.
  const loadsBefore = origin.loads;
  const burst = await Promise.all(Array.from({ length: 5 }, () => get(app, "beta")));
  console.log(
    `5× concurrent GET /reports/beta -> all identical: ${burst.every((b) => b === burst[0])}`,
  );
  console.log(
    `  origin loads added by the burst: ${origin.loads - loadsBefore}   (coalesced to 1)\n`,
  );

  // 4. Invalidate — the next read for that key recomputes (fresh generatedAt).
  await app.handle("POST", "/reports/alpha/invalidate");
  console.log(`POST /reports/alpha/invalidate -> forgotten`);
  console.log(`GET /reports/alpha -> ${await get(app, "alpha")}   (miss — recomputed)`);
  console.log(`  origin loads so far: ${origin.loads}\n`);

  // 5. Sweep — reclaim expired rows. Nothing has expired under the real clock and
  //    a 60s TTL, so this reclaims 0; the frozen-clock test drives the non-zero case.
  const sweep = await app.handle("POST", "/cache/sweep");
  console.log(`POST /cache/sweep -> ${sweep.body}`);

  close();
}

await main();
