/**
 * The server half of the durable `live()` round-trip demo (ADR 0042 Tier 4, v1 Inc5/Inc6).
 *
 * This is deliberately the SAME shape as `examples/live`'s app — a shape engine polling
 * `notes`, mounted at `GET /__lesto/live-data` — minus that example's auth layer (this demo
 * has one shared, un-tenanted list; the durable OPFS store and the bundler wiring are what
 * this example exists to prove, not authorization). It additionally serves the Vite-built
 * client bundle (`../dist/`) as static files, using `@lesto/runtime`'s own `nodeStaticReader` /
 * `contentTypeOf` (the same reader the framework's static-site zones use — see
 * `packages/runtime/src/static-reader.ts`), so `bun run serve.ts` after `bun run build` is the
 * whole app with no bespoke file-serving code.
 */

import { createDb, createTableSql } from "@lesto/db";
import type { Db } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import { createLiveDataHttpHandlers, createShapeEngine } from "@lesto/live-server";
import type { ShapeEngine } from "@lesto/live-server";
import { contentTypeOf, nodeStaticReader } from "@lesto/runtime";
import { lesto } from "@lesto/web";

import { notes } from "./schema";

/** What {@link buildApp} returns: the booted app plus the handles the demo / tests read. */
export interface Booted {
  app: App;

  /** The shape engine the live handler subscribes through — stopped on teardown. */
  engine: ShapeEngine;

  /** The typed handle the mutation writes through and the engine polls — one shared sqlite. */
  db: Db;
}

// `vite build`'s output (see `../vite.config.ts`) — read relative to this module so the demo
// runs the same whether launched from the repo root or this directory. `nodeStaticReader`
// itself refuses any path that escapes this root (a `..` traversal attempt), so this demo's
// static serving needs no bespoke safety check of its own.
const readBuiltFile = nodeStaticReader(new URL("../dist/", import.meta.url).pathname);

/**
 * Read a built file out of `dist/` and answer it with the right content-type, or a 404 when
 * the build has not run yet (`bun run build` first — see the README). No zone system, no
 * prerendering — this demo is a plain static-file byte-server, since the ONE thing under test
 * is whether `vite build` wired the OPFS driver's dynamic import correctly.
 */
async function serveBuiltFile(relativePath: string): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}> {
  const body = await readBuiltFile(relativePath);

  if (body === undefined) {
    return {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: `Not built yet: ${relativePath}. Run "bun run build" first (see README.md).`,
    };
  }

  return { status: 200, headers: { "content-type": contentTypeOf(relativePath) }, body };
}

/** Boot the durable-store demo: the shape stream, the write, and the built client bundle. */
export async function buildApp(options: { handle: KernelDatabase }): Promise<Booted> {
  const db = createDb(options.handle);

  await db.exec(createTableSql(notes));

  // The full-table poll interval — short so a write appears "live" quickly in manual testing.
  // v0's coarse floor; v1 replaces the poll with logical replication (same engine, see
  // `examples/live`'s app for the fuller Inc2+ story).
  const engine = createShapeEngine({ db, tables: [notes], pollMs: 200 });

  // No auth in this demo (one shared list) — every shape is authorized, and the principal is
  // the unit type. `examples/live`'s app is the parameter-authorization version of this shape.
  const handlers = createLiveDataHttpHandlers<null>({
    engine,
    resolvePrincipal: () => null,
    authorizeShape: () => true,
  });

  const api = lesto()
    // The local-first row-data stream (ADR 0042) — the runtime recognizes this reserved path
    // as a long-lived stream, so the held connection takes no in-flight slot.
    .get("/__lesto/live-data", handlers.liveData)

    // The one mutation: insert a note. No topic to publish and no fan-out to trigger — the
    // engine's next poll tick observes the new row and streams the insert to every client.
    .post("/notes", async (c) => {
      const body = (c.req.body ?? {}) as { text?: unknown };
      const text = String(body.text ?? "").trim();

      if (text === "") return c.json({ error: "empty" }, 400);

      const note = await db
        .insert(notes)
        .values({ text, done: false, createdAt: new Date() })
        .returning()
        .get();

      return c.json({ note }, 201);
    })

    // The built client bundle — `/` is `dist/index.html`, everything else is read straight out
    // of `dist/` by its path (the Vite build's fixed, unhashed filenames — see vite.config.ts).
    .get("/", async () => serveBuiltFile("index.html"))
    .get("/*file", async (c) => serveBuiltFile(c.param("file").join("/")));

  const app = await createApp({ db: options.handle, app: api });

  return { app, engine, db };
}
