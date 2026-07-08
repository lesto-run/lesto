/**
 * Deploy the cache example to Cloudflare with Alchemy (ADR 0044) — TypeScript
 * IaC, no `wrangler.toml`. Run it to deploy:
 *
 *   bunx alchemy login            # one-time: Alchemy needs its OWN CF creds
 *   bun alchemy.run.ts            # deploy   → prints the live url
 *   bun alchemy.run.ts --destroy  # tear down
 *
 * A single Worker (`worker.ts`) bound to a Cloudflare D1 database. The SAME
 * `@lesto/cache` SQL store the Node leg runs on a file, run here on D1 — so the
 * read-through cache is durable across the edge's ephemeral isolates.
 *
 * After `finalize()`, a post-deploy smoke drives the live url: it GETs the same
 * report twice and asserts the second is a HIT (identical `generatedAt`) served
 * from D1. That makes `bun alchemy.run.ts` the mechanical "it deploys AND the
 * cache actually works on the edge" gate CI runs on every push to main — not a
 * human clicking around.
 */

import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";

// Shared deploy state in a Cloudflare-Durable-Object-backed SQLite store (ADR 0044 D5), encrypted
// under `ALCHEMY_STATE_TOKEN` (the SAME value across every adopting environment — D4), so CI and a
// teammate's machine adopt + tear down the SAME resources instead of orphaning them.
const app = await alchemy("lesto-example-cache", {
  stateStore: (scope) =>
    new CloudflareStateStore(scope, {
      forceUpdate: process.env.ALCHEMY_STATE_FORCE_UPDATE === "1",
    }),
});

// The D1 database backing the cache table. `adopt: true` so a re-deploy reuses
// the existing database instead of failing on "already exists".
const db = await D1Database("cache-db", {
  name: `${app.name}-${app.stage}-db`,
  adopt: true,
});

const worker = await Worker("cache-edge", {
  name: `${app.name}-${app.stage}`,
  entrypoint: "worker.ts",
  bindings: { DB: db },
  url: true,
  compatibilityDate: "2025-04-01",
  compatibilityFlags: ["nodejs_compat"],
});

const url = worker.url;
if (url === undefined) throw new Error("cache Worker has no url (expected `url: true`)");

console.log("cache edge:", url);
console.log("  GET  ", `${url}/reports/:id`);
console.log("  POST ", `${url}/reports/:id/invalidate`);
console.log("  POST ", `${url}/cache/sweep`);

await app.finalize();

await verifyLive(url);

/**
 * Post-deploy smoke: GET the same report twice and prove the second read is a
 * cache HIT served from D1 — identical `generatedAt` means the origin did NOT
 * recompute. The first GET is retried with backoff to absorb cold-start + the
 * brief propagation window after a fresh deploy; a persistent non-200 fails the
 * deploy loudly rather than shipping a broken Worker.
 */
async function verifyLive(base: string): Promise<void> {
  const target = `${base}/reports/smoke`;

  const first = await getReportWithRetry(target);
  const second = await fetchReport(target);

  if (second === undefined) {
    throw new Error(`smoke: second GET ${target} did not return a report`);
  }

  if (first.generatedAt !== second.generatedAt) {
    throw new Error(
      `smoke: expected a cache hit (identical generatedAt) but got ${first.generatedAt} then ${second.generatedAt}`,
    );
  }

  console.log(`smoke: warm cache hit through D1 — generatedAt ${first.generatedAt} ✓`);
}

interface ReportShape {
  readonly generatedAt: number;
}

async function fetchReport(target: string): Promise<ReportShape | undefined> {
  const response = await fetch(target);

  if (!response.ok) return undefined;

  return (await response.json()) as ReportShape;
}

async function getReportWithRetry(target: string): Promise<ReportShape> {
  const delaysMs = [500, 1000, 2000, 4000, 8000];

  for (const [attempt, delayMs] of delaysMs.entries()) {
    const report = await fetchReport(target);
    if (report !== undefined) return report;

    console.log(
      `smoke: GET ${target} not ready (attempt ${attempt + 1}); retrying in ${delayMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const finalTry = await fetchReport(target);
  if (finalTry !== undefined) return finalTry;

  throw new Error(`smoke: GET ${target} never returned 200 after ${delaysMs.length + 1} attempts`);
}
