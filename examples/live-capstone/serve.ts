/**
 * Serve the Tier-4 v1 capstone over live HTTP, on either change source (ADR 0042 Inc8).
 *
 *   # dev (the SQLite v0 poll — the default, zero setup):
 *   bun run build && bun run serve
 *
 *   # prod (the REAL Postgres logical-replication path):
 *   LESTO_LIVE_SOURCE=pg LESTO_LIVE_PG_URL=postgres://user:pw@host:5432/db bun run build && bun run serve
 *
 * Then open http://127.0.0.1:3000 in a real browser (the durable OPFS store + cross-tab relay need
 * one — see README.md). The change source is chosen fail-closed by {@link resolveSourceConfig}: `pg`
 * without a URL refuses to boot rather than silently run the dev poll.
 *
 * This file OWNS the change source's lifecycle (ADR 0042 — the slot pins WAL until acked): it runs the
 * app-owned Postgres bootstrap, `start()`s the source before serving, and `stop()`s it on SIGTERM so
 * the slot is dropped and WAL stops piling up.
 */

import type { KernelDatabase } from "@lesto/kernel";
import { openPostgres } from "@lesto/pg";
import { openSqlite, serve } from "@lesto/runtime";

import { buildApp, CAPSTONE_PUBLICATION, resolveSourceConfig } from "./src/app";
import { setupPgSchema } from "./src/pg-setup";
import { capstoneTables } from "./src/schema";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const sourceConfig = resolveSourceConfig(process.env);

  // Open the right handle for the chosen source, and (pg only) establish the replication
  // preconditions before the source's slot references the publication.
  const { handle, close } =
    sourceConfig.kind === "pg"
      ? await openPgHandle(sourceConfig.url, sourceConfig.publication ?? CAPSTONE_PUBLICATION)
      : await openSqliteHandle();

  const booted = await buildApp({ handle, source: sourceConfig });

  // Start the change source (creating its slot) BEFORE serving, so the first subscriber tails from a
  // live feed. The engine seeds each shape's snapshot from the pool; the source carries the tail.
  await booted.source?.start();

  const server = await serve(booted.app, { port: PORT, host: "127.0.0.1" });

  console.log(
    `Capstone (${sourceConfig.kind}) on http://127.0.0.1:${server.port} — shapes stream at ` +
      `/__lesto/live-data. ${sourceConfig.kind === "poll" ? "Set LESTO_LIVE_SOURCE=pg + LESTO_LIVE_PG_URL for the real replication path." : ""}`,
  );

  const shutdown = (): void => {
    booted.engine.stop();

    void Promise.resolve()
      .then(() => booted.source?.stop()) // drop the WAL-pinning slot
      .then(() => server.close())
      .then(close)
      .then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** A booted database handle plus its drain — uniform across the two source paths. */
interface OpenHandle {
  readonly handle: KernelDatabase;
  readonly close: () => void | Promise<void>;
}

/** Open a Postgres handle and run the app-owned bootstrap (tables + REPLICA IDENTITY FULL + publication). */
async function openPgHandle(url: string, publication: string): Promise<OpenHandle> {
  const { db, close } = await openPostgres({ connectionString: url });

  await setupPgSchema(db, { tables: capstoneTables, publication });

  return { handle: db, close };
}

/** Open the in-process SQLite handle for the dev poll path. */
async function openSqliteHandle(): Promise<OpenHandle> {
  const { db, close } = await openSqlite();

  return { handle: db, close };
}

void main();
