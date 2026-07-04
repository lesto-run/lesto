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
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp, CAPSTONE_PUBLICATION, CAPSTONE_SLOT, resolveSourceConfig } from "./src/app";
import { cleanPg, setupPgSchema } from "./src/pg-setup";
import { capstoneTables } from "./src/schema";

const PORT = Number(process.env.PORT ?? 3000);

// Bind loopback by default (a local `bun run serve` should never be reachable off the box), but let a
// container override it: a Fly/Render/Railway machine only receives traffic if the process listens on
// the machine's interface, not `127.0.0.1` — so the Dockerfile sets `HOST=0.0.0.0`. See DEPLOY.md.
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const sourceConfig = resolveSourceConfig(process.env);

  // Open the right handle for the chosen source, and (pg only) establish the replication
  // preconditions before the source's slot references the publication.
  const { handle, close } =
    sourceConfig.kind === "pg"
      ? await openPgHandle(
          sourceConfig.url,
          sourceConfig.publication ?? CAPSTONE_PUBLICATION,
          sourceConfig.slot ?? CAPSTONE_SLOT,
        )
      : await openSqliteHandle();

  const booted = await buildApp({ handle, source: sourceConfig });

  // Start the change source (creating its slot) BEFORE serving, so the first subscriber tails from a
  // live feed. The engine seeds each shape's snapshot from the pool; the source carries the tail.
  await booted.source?.start();

  // serveWithGracefulShutdown owns what this file used to hand-roll — SIGINT + SIGTERM, the
  // double-signal guard, the `.catch`(exit 1) — plus a force-exit backstop it previously lacked
  // (see @lesto/runtime). `onShutdown` stops the engine and drops the WAL-pinning slot BEFORE the
  // drain (the source must stop producing first); `onClosed` closes the db AFTER the drain.
  const server = await serveWithGracefulShutdown(booted.app, {
    port: PORT,
    host: HOST,
    onShutdown: async () => {
      booted.engine.stop();

      await booted.source?.stop(); // drop the WAL-pinning slot
    },
    onClosed: close,
  });

  console.log(
    `Capstone (${sourceConfig.kind}) on http://${HOST}:${server.port} — shapes stream at ` +
      `/__lesto/live-data. ${sourceConfig.kind === "poll" ? "Set LESTO_LIVE_SOURCE=pg + LESTO_LIVE_PG_URL for the real replication path." : ""}`,
  );
}

/** A booted database handle plus its drain — uniform across the two source paths. */
interface OpenHandle {
  readonly handle: KernelDatabase;
  readonly close: () => void | Promise<void>;
}

/** Open a Postgres handle and run the app-owned bootstrap (tables + REPLICA IDENTITY FULL + publication). */
async function openPgHandle(url: string, publication: string, slot: string): Promise<OpenHandle> {
  const { db, close } = await openPostgres({ connectionString: url });

  // Self-heal a slot a prior HARD CRASH left orphaned: `start()` would otherwise fail on
  // `CREATE_REPLICATION_SLOT` ("already exists"), and an orphaned slot pins WAL (the disk-fill footgun
  // ADR 0042 makes the deployment own). Safe to drop-then-recreate here — a fresh serve resumes no
  // client state (a connecting client re-snapshots), so the pre-crash slot position is not needed.
  await cleanPg(db, { slots: [slot] });
  await setupPgSchema(db, { tables: capstoneTables, publication });

  return { handle: db, close };
}

/** Open the in-process SQLite handle for the dev poll path. */
async function openSqliteHandle(): Promise<OpenHandle> {
  const { db, close } = await openSqlite();

  return { handle: db, close };
}

void main();
