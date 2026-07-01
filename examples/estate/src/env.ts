/**
 * The estate example's typed environment (`@lesto/env`).
 *
 * The Node entry point (`serve.ts`) reads its knobs through this one validated
 * schema instead of ad-hoc `Number(process.env.PORT ?? 3000)` /
 * `process.env.LESTO_PREACT === "1"` — so a bad `PORT` fails loudly at boot and each
 * value is typed at the use site. (`lesto dev` reads `--port` itself; the local dev
 * server no longer goes through this module.) The edge Worker (`worker.ts`) reads its
 * config off the Worker `env` binding, not `process.env`, so it does NOT import this module.
 */

import { defineEnv, envField } from "@lesto/env";

export const env = defineEnv({
  /** The HTTP port the local server binds. */
  PORT: envField.port().default(3000),

  /** Opt the dev/build CLIENT bundle into Preact's compat layer (smaller bytes). */
  LESTO_PREACT: envField.boolean().default(false),
});
