/**
 * The one app behind both zones, assembled the canonical way: a `keel.app.ts`
 * `KeelAppConfig` booted by `@keel/kernel`'s `createApp`.
 *
 * The dispatch core sits over a fresh `Identity` (built once per config, closed
 * over by the route handlers), whose in-memory SQLite is seeded with the demo
 * accounts — so a fresh `buildApp()` is a self-contained world for tests and the
 * dev server alike. Identity migrates + seeds its own schema in `buildIdentity`,
 * so the kernel runs no migrations; it just threads the same handle through.
 *
 * CSRF is the framework's, not the app's: `secureStack({ originCheck: {} })`
 * refuses a cross-site state-changing request by reading the browser's
 * `Sec-Fetch-Site` — no per-form token to mint, thread, and verify (ADR 0005).
 * The request-shaped batteries drop onto the `keel()` chain via
 * `fromRequestMiddleware`, applied with `.use` before the routes so every route
 * (and every unmatched path — a CORS preflight, say) runs inside them.
 *
 * Durable by default (ADR 0013): the same `handle` is threaded into BOTH
 * `secureStack({ db })` — so the node rate limiter keys against the shared
 * `keel_rate_limits` table instead of a per-process `Map` — AND `createApp`'s
 * `db` slot, where the kernel installs the session + rate-limit schemas after
 * migrate. Sessions are already SQL-backed in `buildIdentity` (its own
 * `sqlSessionStore`), so a `createApp({ db })` boot shares sessions and limits
 * through SQL with zero extra wiring. The `:memory:` demo resets both on
 * restart, but the wiring is exactly what a file-backed SQLite or Postgres
 * deploy copies for real fleet-correctness.
 */

import { createApp, secureStack } from "@keel/kernel";
import type { App, KeelAppConfig } from "@keel/kernel";
import { fromRequestMiddleware, keel } from "@keel/web";

import type { TraceSeams } from "@keel/observability";

import { buildEstateRoutes } from "./controllers";
import { buildIdentity } from "./identity";

/**
 * The node serve path's per-client rate limit — a generous token bucket (a burst
 * of 60, refilling 10/s) wired DURABLY over the shared SQL handle by
 * `secureStack({ db })`. Generous on purpose: it sheds a flood without tripping
 * normal browsing, and (unlike the edge's per-isolate memory limiter, ADR 0013
 * §8) it is fleet-correct — every node throttles against the same buckets.
 */
const NODE_RATE_LIMIT = { capacity: 60, refillPerSecond: 10 } as const;

/**
 * A fresh `KeelAppConfig` — fresh identity, fresh seeded DB — each call.
 *
 * This is what `keel.app.ts` default-exports for the CLI, and what `buildApp`
 * boots. Returning a factory (not a singleton) is what keeps every test world
 * isolated.
 */
export async function buildAppConfig(secret?: string, seams?: TraceSeams): Promise<KeelAppConfig> {
  const { identity, handle } = await buildIdentity(secret, seams);

  // Zero-token, header-based CSRF on every state-changing request, plus a
  // DURABLE per-client rate limit over the shared SQL handle (ADR 0013):
  // `secureStack({ db })` auto-wires `sqlRateLimitStore`, so the limiter keys
  // against `keel_rate_limits` rather than per-process memory — fleet-correct
  // with zero config. Applied before the routes so it wraps the whole app
  // (matched routes and 404s alike). `.client(...)` is declared on the ROOT: it
  // emits the `<script type="module">` hydration tag in every page's <head>, and
  // `.route()` composes a sub-app's routes/layouts/data but NOT its client-module
  // config, so it must live here.
  const app = keel()
    .use(
      ...secureStack({
        originCheck: {},
        rateLimit: NODE_RATE_LIMIT,
        db: handle,
      }).map(fromRequestMiddleware),
    )
    .client("/client.js")
    .route(buildEstateRoutes(identity));

  // The client-error beacon sink (operability-dx item 3): a hydration failure in
  // a real browser POSTs to `/__keel/client-errors`, and this wires that beacon to
  // the tracer as a `client.island_error` span — paired with the server traces.
  // Absent seams leave the default structured-log sink in place.
  if (seams !== undefined) {
    app.clientErrors((event) => seams.onClientError(event));

    // The browser-RUM receiver (ARCHITECTURE.md §7): the browser POSTs the spans
    // it built from `PerformanceObserver` — navigation, resource, web-vital — to
    // `/__keel/browser-spans`, each carrying the SERVER trace id it adopted from
    // the SSR-injected `keel-traceparent` meta. Wiring the sink to
    // `seams.onBrowserSpan` lands them in the SAME OTLP collector as the server
    // spans, joined by trace id — making the UI→API→DB trace real, not aspirational.
    app.browserSpans((span) => seams.onBrowserSpan(span));
  }

  return {
    db: handle,
    app,
    // estate composes its own secureStack above (originCheck + a DURABLE rate
    // limit over the shared SQL handle), so opt OUT of the kernel's default
    // rate-limit baseline — otherwise every request would burn a token in two
    // limiters, halving capacity and doubling the store round-trips (ADR 0016).
    secure: false,
  };
}

/** Boot the app the kernel way: `createApp` over a fresh config. */
export async function buildApp(secret?: string, seams?: TraceSeams): Promise<App> {
  return createApp(await buildAppConfig(secret, seams));
}
