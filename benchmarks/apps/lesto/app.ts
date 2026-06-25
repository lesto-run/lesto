/**
 * The bench app's ROUTES — defined once and shared by BOTH runtimes Lesto targets:
 * the node server (`server.ts`, via `@lesto/runtime`'s `serve`) and the Cloudflare
 * Worker (`worker.ts`, via `@lesto/cloudflare`'s `toFetchHandler`).
 *
 * It imports ONLY `@lesto/web` (the transport-neutral dispatch — a `lesto()` app's
 * `.handle` is a pure `(method, path) => LestoResponse`) and the workload contract.
 * It deliberately does NOT import `@lesto/runtime` (which pulls `node:http` +
 * `openSqlite`), so the Worker bundle never drags node-only code onto the edge — the
 * same dispatch, two transports.
 */

import { lesto } from "@lesto/web";

import {
  jsonObject,
  plaintextBody,
  realisticBody,
  simulateDbLatency,
  ssrBody,
} from "../_contract.mjs";

// Build the SSR body once at module load — every server-tier app (and the edge
// build) delivers the SAME bytes, so /ssr is a clean transport comparison.
const SSR_BODY = ssrBody();

/** The four workload routes (see `../../workloads.md`), as a transport-neutral `lesto()` app. */
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
