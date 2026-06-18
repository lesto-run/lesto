/**
 * Run the whole site set over LIVE HTTP — both zones, one origin.
 *
 *   bun run examples/estate/serve.ts
 *
 * Three steps, the real pipeline:
 *   1. Prerender the static marketing site to `out/` (`buildStaticSites` — it
 *      fails loudly on any page the app can't render, before writing a thing).
 *   2. Build the path front door (`dispatchSites`): `/` and `/about` come off
 *      the prerendered files; `/mls/*` is the live app. One origin, so the
 *      session cookie set by `/mls` is seen by the static pages too.
 *   3. Stand a node:http server in front of it all.
 *
 * Then:
 *   curl -i http://127.0.0.1:3000/                         # static marketing HTML (+ island manifest)
 *   curl -i http://127.0.0.1:3000/mls/api/session          # 401, nobody signed in
 *   curl -i -X POST http://127.0.0.1:3000/mls/api/sign-in  # 303 + Set-Cookie (survives the path mount)
 *   curl -i -b "lesto_session=<token>" .../mls/api/session  # 200 { user } — same-origin session
 */

import { fileURLToPath } from "node:url";

import { serve } from "@lesto/runtime";
import { parseTraceparent, tracesFromEnv } from "@lesto/observability";
import { currentRequestSpan } from "@lesto/web";
import type { CurrentSpan } from "@lesto/observability";

import { buildProductionSite } from "./src/production";

// Running the estate example locally IS the public demo, so default it into demo
// mode (committed fallback secrets + passwordless sign-in) unless the operator
// set their own LESTO_AUTH_SECRET. The deployed Worker (`worker.ts`) never does
// this, so production stays fail-closed on a missing secret.
process.env["LESTO_DEMO"] ??= "1";

const PORT = Number(process.env["PORT"] ?? 3000);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const OUT = fileURLToPath(new URL("./out", import.meta.url));

/** Flush buffered spans to the collector every five seconds (see serve.ts/run.ts). */
const TRACE_FLUSH_INTERVAL_MS = 5_000;

async function main(): Promise<void> {
  // The OTLP tracer, constructed the canonical way (operability-dx item 3): off
  // unless `LESTO_OTLP_URL` is set (the two-env-var setup, see README). The
  // `currentSpan` seam reads the request span the runtime publishes, so a db
  // query / auth event / mail delivery fired during a request parents on it.
  //
  //   LESTO_OTLP_URL=http://localhost:4318/v1/traces  bun run serve.ts
  //
  // This is estate-as-the-OTLP-reference: the SAME `tracesFromEnv` + seam wiring
  // a production Lesto app uses, dogfooded on a real app.
  const traces = tracesFromEnv(process.env, {
    currentSpan: currentRequestSpan as CurrentSpan,
  });

  if (traces !== undefined) {
    console.log("OTLP tracing on → spans flush to LESTO_OTLP_URL");
  }

  // Prerender + bundle the client + build the front-door dispatch — the same
  // assembly the integration test exercises (src/production.ts). The tracer's
  // seams ride into the app so db/identity/mail/client-error events become spans.
  const { dispatch, manifest } = await buildProductionSite(OUT, ROOT, {
    ...(traces === undefined ? {} : { seams: traces.seams }),
  });

  for (const site of manifest) {
    console.log(`prerendered ${site.site}: ${site.pages.length} pages`);
  }

  // The steady flush cadence (a long-lived node service): flush every interval,
  // and once more on drain. `undefined` when tracing is off — nothing to flush.
  const stopFlush = traces?.startInterval(TRACE_FLUSH_INTERVAL_MS);

  // Serve it. The dispatcher is the app's `handle` as far as the runtime cares.
  // When tracing is on, every request mints a span, an inbound `traceparent`
  // joins one trace, and the final batch flushes on graceful drain.
  const server = await serve(
    { handle: dispatch, migrationsApplied: [] },
    {
      port: PORT,
      ...(traces === undefined
        ? {}
        : { tracer: traces.requestTracer, parseTraceparent, onDrain: () => traces.flush() }),
    },
  );

  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  ${url}/         static marketing (with the Account island)`);
  console.log(`  ${url}/mls      the dynamic, authed app`);

  const shutdown = async (): Promise<void> => {
    // Drain first (the server's `onDrain` flushes the final spans), then stop the
    // interval — order matters, so the last flush is not cut short.
    await server.close();

    stopFlush?.();

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
