/**
 * The one app behind both zones.
 *
 * No database: the demo's session store is in-memory and its listings are a
 * constant, so we assemble the web core directly with `@keel/web`'s
 * `Application` rather than the full kernel. Its `handle` is what both the build
 * (to prerender the marketing pages) and the serve (for the live `/mls` zone)
 * call.
 */

import { Application } from "@keel/web";
import type { ControllerClass } from "@keel/web";

import { router } from "./routes";
import { MarketingController, MlsController } from "./controllers";

export function buildApp(): Application {
  return new Application({
    router,
    controllers: {
      marketing: MarketingController as ControllerClass,
      mls: MlsController as ControllerClass,
    },
  });
}
