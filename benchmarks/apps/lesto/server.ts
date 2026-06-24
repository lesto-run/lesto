/**
 * The Lesto benchmark app — a real `lesto()` app behind the genuine `@lesto/runtime`
 * `serve` (node:http), serving the three workload routes from `../workloads.md`.
 *
 *   PORT=3100 bun run server.ts
 *
 * Resolves `@lesto/*` from the monorepo root (no install needed — that is why this
 * app has no `workspace:*` deps in its package.json and the driver's `prepare` for
 * it is empty). The other framework apps are self-contained installs.
 *
 * Like every server-tier app, `/ssr` delivers the contract's server-built HTML
 * document (`ssrBody()`); the render-engine comparison lives in the in-process
 * suite (`../../compare`). So this measures Lesto's routing + response pipeline
 * delivering a ~2 KB page, head-to-head with the other servers doing the same.
 */

import { createApp } from "@lesto/kernel";
import { openSqlite, serve } from "@lesto/runtime";
import { lesto } from "@lesto/web";

import {
  jsonObject,
  plaintextBody,
  realisticBody,
  simulateDbLatency,
  ssrBody,
} from "../_contract.mjs";

const PORT = Number(process.env.PORT ?? 3100);

// Build the SSR body once at boot — every server-tier app delivers the SAME bytes,
// so /ssr is a clean HTTP-throughput comparison, not a renderer contest.
const SSR_BODY = ssrBody();

export const webApp = lesto()
  .get("/plaintext", (c) => c.text(plaintextBody))
  .get("/json", (c) => c.json(jsonObject))
  .get("/ssr", (c) => c.html(SSR_BODY))
  // /realistic re-renders the catalog page behind a simulated DB round-trip on EVERY
  // request (no caching) — see `_contract.mjs`. Async to exercise the await pipeline.
  .get("/realistic", async (c) => {
    await simulateDbLatency();

    return c.html(realisticBody());
  });

/**
 * Build the booted kernel app (migrations are a no-op here — no schema needed).
 *
 * `secure` defaults to the kernel default, which is **per-client rate-limiting ON**
 * (the pit-of-success default) — so a default Lesto app does a rate-limit store op
 * on every request. Pass `{ secure: false }` to measure the routing/context
 * pipeline WITHOUT that baseline, for a fairer head-to-head with a bare router.
 */
export async function buildBenchApp(opts: { secure?: false } = {}): Promise<{
  app: Awaited<ReturnType<typeof createApp>>;
  close: () => void;
}> {
  const { db, close } = await openSqlite();
  const app =
    opts.secure === false
      ? await createApp({ db, app: webApp, secure: false })
      : await createApp({ db, app: webApp });

  return { app, close };
}

async function main(): Promise<void> {
  // `LESTO_BENCH_SECURE=false` boots the routing/context pipeline WITHOUT the default
  // secure stack (rate limiter etc.) — the `lesto-bare` real-server matrix entry, the
  // fair head-to-head with the bare competitor servers (mirrors the in-process suite).
  const secureOff = process.env.LESTO_BENCH_SECURE === "false";
  const { app } = await buildBenchApp(secureOff ? { secure: false } : {});

  // `compress: false` — every server-tier app serves UNCOMPRESSED so the comparison is
  //   fair (the runtime negotiates Brotli/gzip by default; the driver rejects any
  //   Content-Encoding mismatch). `logRequest: noop` — silence per-request access logging
  //   so Lesto isn't taxed with hot-path I/O the bare competitors don't do.
  const server = await serve(app, { port: PORT, compress: false, logRequest: () => {} });
  console.log(
    `lesto bench app${secureOff ? " (secure off)" : ""} listening on http://127.0.0.1:${server.port}`,
  );

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// Only boot when run directly; importable for the parity check without a socket.
if (import.meta.main) {
  await main();
}
