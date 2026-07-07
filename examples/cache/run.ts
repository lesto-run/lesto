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
 *
 * Then a second, shorter leg drives the OTHER store @lesto/cache ships — the
 * in-memory `MemoryStore`, used directly against the `Cache` API (no SQLite, no
 * HTTP) — through miss → hit → TTL expiry, so both stores are demonstrated.
 */

import { Cache, MemoryStore, systemClock } from "@lesto/cache";
import { openSqlite } from "@lesto/runtime";

import { buildApp, createReportsOrigin, type Report } from "./src/app";

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

  // 6. The OTHER store. Everything above rode @lesto/cache's SQL store (persistent,
  //    behind HTTP). The in-memory `MemoryStore` is the zero-config default, used
  //    DIRECTLY against the `Cache` API — no SQLite, no routes. Same read-through
  //    beats (miss → hit → TTL expiry), but ephemeral: it lives and dies with the
  //    process, so there is nothing to persist and nothing to sweep. A controllable
  //    clock lets us watch the TTL lapse without waiting out a real 60s.
  console.log("\n--- @lesto/cache in-memory store (MemoryStore, used directly) ---");

  let memNow = systemClock();
  const memClock = (): number => memNow;
  const memOrigin = createReportsOrigin(memClock, ORIGIN_DELAY_MS);
  const memCache = new Cache({ store: new MemoryStore(), clock: memClock });
  const remember = (): Promise<Report> =>
    memCache.remember("report:gamma", () => memOrigin.load("gamma"), { ttlMs: TTL_MS });

  const cold = await remember();
  console.log(`remember report:gamma -> generatedAt ${cold.generatedAt}   (miss)`);
  console.log(`  origin loads so far: ${memOrigin.loads}\n`);

  const warm = await remember();
  console.log(
    `remember report:gamma -> generatedAt ${warm.generatedAt}   (hit — origin untouched: ${memOrigin.loads === 1})`,
  );
  console.log(`  origin loads so far: ${memOrigin.loads}\n`);

  // Advance past the TTL: the entry is expired, so the next remember is a miss and
  // the origin re-runs with a fresh (later) stamp.
  memNow += TTL_MS + 1;
  const expired = await remember();
  console.log(
    `remember report:gamma (after TTL) -> generatedAt ${expired.generatedAt}   (miss — recomputed: ${expired.generatedAt > cold.generatedAt})`,
  );
  console.log(`  origin loads so far: ${memOrigin.loads}`);
}

await main();
