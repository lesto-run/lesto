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
 */

import { createApp, secureStack } from "@keel/kernel";
import type { App, KeelAppConfig } from "@keel/kernel";
import { fromRequestMiddleware, keel } from "@keel/web";

import { buildEstateRoutes } from "./controllers";
import { buildIdentity } from "./identity";

/**
 * A fresh `KeelAppConfig` — fresh identity, fresh seeded DB — each call.
 *
 * This is what `keel.app.ts` default-exports for the CLI, and what `buildApp`
 * boots. Returning a factory (not a singleton) is what keeps every test world
 * isolated.
 */
export async function buildAppConfig(): Promise<KeelAppConfig> {
  const { identity, handle } = await buildIdentity();

  // Zero-token, header-based CSRF on every state-changing request, applied
  // before the routes so it wraps the whole app (matched routes and 404s alike).
  const app = keel()
    .use(...secureStack({ originCheck: {} }).map(fromRequestMiddleware))
    .route(buildEstateRoutes(identity));

  return {
    db: handle,
    app,
  };
}

/** Boot the app the kernel way: `createApp` over a fresh config. */
export async function buildApp(): Promise<App> {
  return createApp(await buildAppConfig());
}
