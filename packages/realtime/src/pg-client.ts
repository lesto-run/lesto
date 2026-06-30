/**
 * The real `pg.Client` factory for the Postgres `LISTEN/NOTIFY` transport — the
 * thin, coverage-excluded wiring (ADR 0040). Every decision the transport makes is
 * tested in `pg-transport.ts` against the {@link PgListenClient} seam; this file is
 * only the irreducible `new pg.Client(...)` construction, which has nothing to test
 * but a live socket.
 *
 * `pg` is an optional peer: a deployment using the Postgres transport installs it.
 * It is imported lazily inside the factory so an app on SQLite (no realtime fleet
 * bus) never needs `pg` on disk just to import `@lesto/realtime`.
 */

import { createRequire } from "node:module";

import type { PgListenClient } from "./pg-transport";

/** Connection config for the dedicated listening client — a libpq URL or field set. */
export type PgClientConfig =
  | string
  | { readonly connectionString?: string; readonly [key: string]: unknown };

/**
 * Build a factory that mints a fresh dedicated listening `pg.Client` from `config`.
 *
 * The transport calls this on `start` and on every reconnect (a dropped `LISTEN`
 * needs a brand-new client). A real `pg.Client` structurally satisfies
 * {@link PgListenClient} — `connect` / `query` / `on('notification'|'error')` /
 * `end` are all native — so no adapter is needed.
 */
export function createPgListenClientFactory(config: PgClientConfig): () => PgListenClient {
  return () => {
    // Lazy + indirect so the `pg` dependency is only resolved when the Postgres
    // transport is actually constructed, never at import time.
    const require = createRequire(import.meta.url);
    const { Client } = require("pg") as { Client: new (config: PgClientConfig) => PgListenClient };

    return new Client(config);
  };
}
