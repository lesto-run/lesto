/**
 * The Tier-4 v1 **capstone** app (ADR 0042, Inc8, `L-b1501de9`) — ONE multi-tenant local-first app
 * that proves the whole v1 together, over the SAME `live()` surface on TWO change sources:
 *
 *   - **prod: Postgres logical replication** (`{ kind: "pg" }`) — a dedicated replication slot +
 *     `pgoutput` feeds the shape engine, which authorizes and diffs per row and streams auth-scoped
 *     row data + LSN-exact resume. This is the path the acceptance gate (`test/acceptance.pg.ts`)
 *     drives the full matrix over.
 *   - **dev: the SQLite full-table poll** (`{ kind: "poll" }`) — the v0 stand-in, identical `live()`
 *     surface, coarse resume floor. The dev/prod delta is STATED, not hidden (README + the vitest
 *     parity leg), exactly as ADR 0042 *Phasing* requires.
 *
 * The two are mutually exclusive per engine and selected by ONE fail-closed seam
 * ({@link resolveSourceConfig}): `pg` requested without a URL is a LOUD boot error, never a silent
 * fall back to the poll that would fake the parity claim.
 *
 * Everything ABOVE the change source is one implementation shared by both: the parameter-level shape
 * authorization (a bound `room_id` the principal may not see is refused at subscribe AND on every
 * re-auth tick), the authorized mutation `POST /messages` (the outbox's replay target — idempotent so
 * an at-least-once replay never duplicates), and the served client bundle. That shared surface IS the
 * moat claim made concrete: one query language, one authz seam, one mutation path, two runtimes.
 */

import { createDb, createTableSql, eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import {
  createLiveDataHttpHandlers,
  createPgReplicationClientFactory,
  createPgReplicationSource,
  createReplicaIdentityProbe,
  createShapeEngine,
} from "@lesto/live-server";
import type { PgReplicationSource, ShapeEngine } from "@lesto/live-server";
import type { ShapeDefinition } from "@lesto/live-protocol";
import { contentTypeOf, nodeStaticReader } from "@lesto/runtime";
import { lesto } from "@lesto/web";
import type { Context } from "@lesto/web";

import { capstoneTables, messages } from "./schema";

/** The capstone's replication slot + publication (a `pg`-mode deployment concern; overridable via env). */
export const CAPSTONE_SLOT = "lesto_capstone";
export const CAPSTONE_PUBLICATION = "lesto_capstone_pub";

/** The default dev poll interval — tight enough that a write feels live in the vitest parity leg. */
const DEFAULT_POLL_MS = 50;

// ---------------------------------------------------------------------------------------------
// The tenancy model (the SAME shape as `examples/live`, renamed to rooms/messages). Membership is a
// relation SEPARATE from `messages` — a change to it never touches a `messages` row, so the
// replication stream cannot observe it (ADR 0042 acceptance (c), cross-relation case): only a
// re-auth re-check catches it. `SESSIONS` is the orthogonal session-validity axis for acceptance (d).
// ---------------------------------------------------------------------------------------------

/** The acting principal: who is connected, and which private rooms they belong to. */
export interface Principal {
  readonly user: string | undefined;

  readonly rooms: ReadonlySet<string>;
}

/** `lobby` is public (anyone, even anonymous); `engineering` is members-only (alice, carol). */
const PUBLIC_ROOMS: ReadonlySet<string> = new Set(["lobby"]);
const MEMBERSHIP: Record<string, Set<string>> = {
  alice: new Set(["engineering"]),
  bob: new Set<string>(),
  // `carol` exists so acceptance (c)'s cross-relation revoke has a principal decoupled from `alice`,
  // whose membership other assertions assume stays intact regardless of order.
  carol: new Set(["engineering"]),
};

/** Currently-valid sessions (acceptance (d)): a revoked session severs even while membership holds. */
const SESSIONS = new Set(["alice", "bob", "carol"]);

/** Resolve a `?user=` value into its principal (its private-room membership). */
export function principalOf(user: string | undefined): Principal {
  const rooms = user === undefined ? new Set<string>() : (MEMBERSHIP[user] ?? new Set<string>());

  return { user, rooms };
}

/** Revoke `user`'s membership in `room` — the SEPARATE membership relation (acceptance (c) cross-relation). */
export function revokeMembership(user: string, room: string): void {
  MEMBERSHIP[user]?.delete(room);
}

/** Revoke `user`'s session — valid membership, invalid session (acceptance (d)). */
export function revokeSession(user: string): void {
  SESSIONS.delete(user);
}

/** Is this principal's session still valid? (The `revalidate` axis, orthogonal to room membership.) */
export function isSessionValid(principal: Principal): boolean {
  return principal.user !== undefined && SESSIONS.has(principal.user);
}

/** May this principal SEE `room`? (public, or a member) — the one rule reads / writes / shapes share. */
export function mayAccessRoom(principal: Principal, room: string): boolean {
  return PUBLIC_ROOMS.has(room) || principal.rooms.has(room);
}

/**
 * Authorize a **bound** shape (ADR 0042 acceptance (a)): the shape must bind a single `room_id` via a
 * `room_id = <value>` filter, and the principal must be allowed to see that room. A shape with no
 * `room_id=` binding is DENIED — the bound value must always be an authorized capability, never an
 * open read of the whole table.
 */
export function authorizeShape(principal: Principal, shape: ShapeDefinition): boolean {
  const roomFilter = shape.where.find((filter) => filter.column === "roomId" && filter.op === "eq");

  if (roomFilter === undefined) return false;

  return mayAccessRoom(principal, String(roomFilter.value));
}

// ---------------------------------------------------------------------------------------------
// The fail-closed change-source seam.
// ---------------------------------------------------------------------------------------------

/** Which change source the engine consumes — the poll (dev) or the Postgres replication tap (prod). */
export type SourceConfig =
  | { readonly kind: "poll"; readonly pollMs?: number }
  | {
      readonly kind: "pg";
      readonly url: string;
      readonly slot?: string;
      readonly publication?: string;
    };

/**
 * Resolve the change source from the environment — the ONE place dev/prod is chosen, fail-closed:
 *
 *   - `LESTO_LIVE_SOURCE=poll` (or unset) → the SQLite dev poll.
 *   - `LESTO_LIVE_SOURCE=pg` → the Postgres replication tap, which REQUIRES `LESTO_LIVE_PG_URL`.
 *     A missing URL is a loud boot error, NEVER a silent fall back to the poll — a prod deploy that
 *     quietly ran the dev stand-in would fake the whole parity claim (the same fail-closed posture
 *     ADR 0043 D2.4 ratified: absence of config must not degrade a security-relevant path).
 *
 * The `pg` peer itself is loaded lazily by the change source / catalog probe; a missing peer throws
 * loudly at first use (never a silent poll), so it needs no separate check here.
 */
export function resolveSourceConfig(env: Record<string, string | undefined>): SourceConfig {
  const kind = env.LESTO_LIVE_SOURCE ?? "poll";
  const hasUrl = (env.LESTO_LIVE_PG_URL ?? "").trim() !== "";

  if (kind === "poll") {
    // A Postgres URL present while the source is the dev poll is almost always a prod deploy that
    // forgot `LESTO_LIVE_SOURCE=pg` — refuse it rather than silently run the stand-in against a real
    // DB (the same fail-closed reason the pg branch refuses a missing URL).
    if (hasUrl) {
      throw new Error(
        "LESTO_LIVE_PG_URL is set but LESTO_LIVE_SOURCE is not 'pg'; refusing to run the SQLite dev " +
          "poll with a Postgres URL present. Set LESTO_LIVE_SOURCE=pg, or unset the URL for dev.",
      );
    }

    return { kind: "poll" };
  }

  if (kind === "pg") {
    const url = env.LESTO_LIVE_PG_URL;

    if (url === undefined || url.trim() === "") {
      throw new Error(
        "LESTO_LIVE_PG_URL is required when LESTO_LIVE_SOURCE=pg (the prod logical-replication " +
          "path); refusing to silently fall back to the SQLite dev poll.",
      );
    }

    return {
      kind: "pg",
      url,
      slot: env.LESTO_LIVE_SLOT ?? CAPSTONE_SLOT,
      publication: env.LESTO_LIVE_PUBLICATION ?? CAPSTONE_PUBLICATION,
    };
  }

  throw new Error(`Unknown LESTO_LIVE_SOURCE "${kind}" — expected "poll" or "pg".`);
}

// ---------------------------------------------------------------------------------------------
// The app.
// ---------------------------------------------------------------------------------------------

/** What {@link buildApp} returns: the booted app plus the handles the demo / gate read. */
export interface Booted {
  app: App;

  /** The shape engine the live handler subscribes through — stopped on teardown. */
  engine: ShapeEngine;

  /**
   * The Postgres change source (pg mode only) — CREATED here but its lifecycle is the caller's: the
   * caller `start()`s it before serving and `stop()`s it on shutdown (dropping the WAL-pinning slot).
   * `undefined` on the poll path.
   */
  source: PgReplicationSource | undefined;

  /** The typed ORM the mutation writes through and the engine reads snapshots from — one connection. */
  db: Db;

  /** Every refused (unauthorized / malformed) shape, surfaced for logging — never streamed. */
  denied: Array<{ user: string | undefined; reason: string }>;
}

/** What {@link buildApp} accepts. */
export interface BuildAppOptions {
  /** The database handle: an `openSqlite` handle (poll) or an `openPostgres` handle (pg). */
  readonly handle: KernelDatabase;

  /** Which change source to run. See {@link resolveSourceConfig} for the fail-closed env resolution. */
  readonly source: SourceConfig;

  /** The re-auth interval in ms — overridden in the acceptance gate so (c)/(d) don't wait 60s. */
  readonly reauthMs?: number;
}

/** Boot the capstone: the change source, the gated read + write, and the served client. */
export async function buildApp(options: BuildAppOptions): Promise<Booted> {
  const { handle, source: sourceConfig } = options;
  const isPg = sourceConfig.kind === "pg";

  // The typed ORM over the SAME handle the mutation writes through and the engine reads snapshots
  // from — dialected so Postgres renders the right DDL/queries (the engine's replication path
  // additionally requires `@lesto/db`-managed tables so booleans/timestamps coerce byte-identically).
  const db = createDb(handle, isPg ? { dialect: "postgres" } : {});

  // On the poll path the app owns its schema (create it before the first poll). On the pg path the
  // schema + `REPLICA IDENTITY FULL` + publication are established by `setupPgSchema` (`src/pg-setup.ts`)
  // BEFORE `buildApp`, since the replication slot the change source creates references the publication.
  if (!isPg) {
    for (const table of capstoneTables) await db.exec(createTableSql(table));
  }

  // Build the change source + engine. The two paths are mutually exclusive: providing `replication`
  // switches the engine off the poll and onto the logical-replication feed. On the pg path the engine
  // ALSO gets the catalog probe that guards each shape's replica identity — TypeScript pairs the feed
  // and the probe, so the delete-from-shape guard can never be forgotten.
  let source: PgReplicationSource | undefined;
  let engine: ShapeEngine;

  if (sourceConfig.kind === "pg") {
    const slot = sourceConfig.slot ?? CAPSTONE_SLOT;
    const publication = sourceConfig.publication ?? CAPSTONE_PUBLICATION;

    source = createPgReplicationSource({
      createClient: createPgReplicationClientFactory(sourceConfig.url, { publication }),
      slot,
    });

    engine = createShapeEngine({
      db,
      tables: capstoneTables,
      replication: { source, replicaIdentity: createReplicaIdentityProbe(sourceConfig.url) },
    });
  } else {
    engine = createShapeEngine({
      db,
      tables: capstoneTables,
      pollMs: sourceConfig.pollMs ?? DEFAULT_POLL_MS,
    });
  }

  const denied: Booted["denied"] = [];

  // Resolve the principal from `?user=` — a session cookie in production, but a query here because a
  // browser `EventSource` cannot set an auth header on its GET.
  const resolvePrincipal = (c: Context): Principal => principalOf(c.query("user") ?? undefined);

  const handlers = createLiveDataHttpHandlers<Principal>({
    engine,
    resolvePrincipal,
    // The parameter-authz seam — re-invoked on the re-auth interval REGARDLESS (ADR 0042
    // (a)/(c)/(d), continuous), so a membership revoked via `revokeMembership` (a relation the
    // `messages` stream can't observe) is caught within `reauthMs`, purge-then-sever.
    authorizeShape,
    // The orthogonal session axis (acceptance (d)): a revoked session severs even while membership
    // holds. Layered ON TOP of the always-on `authorizeShape` re-check.
    revalidate: isSessionValid,
    onDenied: (principal, reason) => {
      denied.push({ user: principal.user, reason });
    },
    ...(options.reauthMs === undefined ? {} : { reauthMs: options.reauthMs }),
  });

  const readBuiltFile = nodeStaticReader(new URL("../dist/", import.meta.url).pathname);

  const api = lesto()
    // The local-first row-data stream (ADR 0042). The runtime recognizes this reserved path as a
    // long-lived stream, so the held connection takes no in-flight slot and is never compressed.
    .get("/__lesto/live-data", handlers.liveData)

    // The authorized READ — the same rows a shape streams, gated by the SAME room-access rule so an
    // inspecting client can only ever pull rows it may see.
    .get("/messages", async (c) => {
      const room = c.query("room") ?? "";
      const principal = principalOf(c.query("user") ?? undefined);

      if (!mayAccessRoom(principal, room)) return c.json({ error: "forbidden" }, 403);

      const rows = await db.select().from(messages).where(eq(messages.roomId, room)).all();

      return c.json({ messages: rows });
    })

    // The MUTATION — the outbox's authorized replay target. It inserts under a CLIENT-supplied id (the
    // Inc6 correlation key), gated by the same room-access rule (no back door into a private room), and
    // is IDEMPOTENT: the outbox replays at-least-once, so a write whose original already landed (its
    // ack was lost) replays with the same id, and the PK conflict is reported as idempotent success
    // — never a spurious error that would roll a landed write back. No topic, no fan-out: the change
    // source observes the new row and streams the `insert` (keyed by that id) to every subscriber.
    .post("/messages", async (c) => {
      const body = (c.req.body ?? {}) as { id?: unknown; room?: unknown; body?: unknown };
      const id = String(body.id ?? "").trim();
      const room = String(body.room ?? "");
      const text = String(body.body ?? "").trim();
      const principal = principalOf(c.query("user") ?? undefined);

      if (!mayAccessRoom(principal, room)) return c.json({ error: "forbidden" }, 403);
      if (id === "" || text === "") return c.json({ error: "id and body are required" }, 400);

      try {
        const message = await db
          .insert(messages)
          .values({
            id,
            roomId: room,
            author: principal.user ?? "anon",
            body: text,
            createdAt: new Date(),
          })
          .returning()
          .get();

        return c.json({ message }, 201);
      } catch (error) {
        // The idempotency truth condition is STRUCTURAL, not a message match: "the original already
        // landed" ⇔ a row with this client-generated id now exists. Checking that (rather than parsing
        // the driver's error string, which differs across SQLite/Postgres and would misclassify an
        // unrelated constraint error as success) keeps the at-least-once replay arm from ever returning
        // a false "ok" that drops a write the server never stored. If the row is NOT there, the insert
        // failed for a real reason → 5xx, so the outbox classifies it "retry" and KEEPS the write.
        const existing = await db.select().from(messages).where(eq(messages.id, id)).all();

        if (existing.length > 0) return c.json({ ok: true }, 200);

        const errorMessage = error instanceof Error ? error.message : String(error);

        return c.json({ error: errorMessage }, 500);
      }
    })

    // The built client bundle — `/` is `dist/index.html`, everything else is read straight out of
    // `dist/` by its path (the Vite build's fixed, unhashed filenames — see `vite.config.ts`).
    // `nodeStaticReader` itself refuses any path escaping `dist/`, so this needs no bespoke check.
    .get("/", async () => serveBuiltFile(readBuiltFile, "index.html"))
    .get("/*file", async (c) => serveBuiltFile(readBuiltFile, c.param("file").join("/")));

  const app = await createApp({
    db: handle,
    app: api,
    ...(isPg ? { dialect: "postgres" as const } : {}),
  });

  return { app, engine, source, db, denied };
}

/** Read a built file out of `dist/` with the right content-type, or a 404 when the build has not run. */
async function serveBuiltFile(
  readBuiltFile: (path: string) => Promise<string | Uint8Array | undefined>,
  relativePath: string,
): Promise<{ status: number; headers: Record<string, string>; body: string | Uint8Array }> {
  const built = await readBuiltFile(relativePath);

  if (built === undefined) {
    return {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: `Not built yet: ${relativePath}. Run "bun run build" first (see README.md).`,
    };
  }

  return { status: 200, headers: { "content-type": contentTypeOf(relativePath) }, body: built };
}
