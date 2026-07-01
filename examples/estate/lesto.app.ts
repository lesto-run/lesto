/**
 * The project entrypoint — the `LestoAppConfig` `@lesto/cli` loads and `createApp`
 * boots, the same shape every Lesto app default-exports.
 *
 * estate keeps its own `serve.ts` / `build.ts` because it does two things the
 * bare `lesto` commands don't: prerender the static marketing zone and bundle
 * the island hydration client. Local dev, though, runs through the framework's
 * own `lesto dev` (package.json — no hand-rolled dev entry), so the dev-only
 * seams (live reload, the dev MCP control plane, the in-preview AI overlay) are
 * wired by the CLI bin, never here: this app-config layer stays free of any dev
 * wiring by design. But the app *assembly* is the canonical one —
 * `buildAppConfig()` over `@lesto/kernel` — so there is one way to build a Lesto
 * app, and this file is it.
 */

import { buildAppConfig } from "./src/app";

// estate is the public demo, so default into demo mode (committed fallback
// secrets) unless the operator set their own LESTO_AUTH_SECRET. A real app would
// not ship this line; the deployed Worker (`worker.ts`) deliberately omits it,
// so production stays fail-closed on a missing secret.
process.env["LESTO_DEMO"] ??= "1";

export default await buildAppConfig();
