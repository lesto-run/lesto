/**
 * The project entrypoint — the `AppConfig` `@keel/cli` loads and `createApp`
 * boots, the same shape every Keel app default-exports.
 *
 * estate keeps its own `serve.ts` / `build.ts` / `dev.ts` because it does two
 * things the bare `keel` commands don't: prerender the static marketing zone
 * and bundle the island hydration client. But the app *assembly* is the
 * canonical one — `buildAppConfig()` over `@keel/kernel` — so there is one way
 * to build a Keel app, and this file is it.
 */

import { buildAppConfig } from "./src/app";

export default await buildAppConfig();
