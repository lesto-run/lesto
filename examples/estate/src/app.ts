/**
 * The one app behind both zones.
 *
 * The dispatch core (`@keel/web`'s `Application`) sits over a fresh `Identity`
 * instance — built once per `buildApp()`, closed over by the controllers. The
 * Identity owns an in-memory SQLite seeded with the demo accounts, so a fresh
 * `buildApp()` is a self-contained world for tests and the dev server alike.
 *
 * We don't reach for the full `@keel/kernel` because the demo's needs are
 * narrower (no app-level migrations beyond identity, no shared DB to thread
 * through other modules). One scoped Identity is the whole battery.
 */

import { Application } from "@keel/web";

import { buildControllers } from "./controllers";
import { buildIdentity } from "./identity";
import { router } from "./routes";

export function buildApp(): Application {
  const { identity } = buildIdentity();

  return new Application({
    router,
    controllers: buildControllers(identity),
  });
}
