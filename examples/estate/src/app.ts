/**
 * The one app behind both zones, assembled the canonical way: a `keel.app.ts`
 * `AppConfig` booted by `@keel/kernel`'s `createApp`.
 *
 * The dispatch core sits over a fresh `Identity` (built once per config, closed
 * over by the controllers), whose in-memory SQLite is seeded with the demo
 * accounts — so a fresh `buildApp()` is a self-contained world for tests and the
 * dev server alike. Identity migrates + seeds its own schema in `buildIdentity`,
 * so the kernel runs no migrations; it just threads the same handle through.
 *
 * CSRF is the framework's, not the app's: `secureStack({ originCheck: {} })`
 * refuses a cross-site state-changing request by reading the browser's
 * `Sec-Fetch-Site` — no per-form token to mint, thread, and verify. (ADR 0005.)
 */

import { createApp, secureStack } from "@keel/kernel";
import type { App, AppConfig } from "@keel/kernel";

import { buildControllers } from "./controllers";
import { buildIdentity } from "./identity";
import { router } from "./routes";

/**
 * A fresh `AppConfig` — fresh identity, fresh seeded DB — each call.
 *
 * This is what `keel.app.ts` default-exports for the CLI, and what `buildApp`
 * boots. Returning a factory (not a singleton) is what keeps every test world
 * isolated.
 */
export async function buildAppConfig(): Promise<AppConfig> {
  const { identity, handle } = await buildIdentity();

  return {
    db: handle,
    router,
    controllers: buildControllers(identity),
    // Zero-token, header-based CSRF on every state-changing request.
    middleware: secureStack({ originCheck: {} }),
  };
}

/** Boot the app the kernel way: `createApp` over a fresh config. */
export async function buildApp(): Promise<App> {
  return createApp(await buildAppConfig());
}
