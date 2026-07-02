/**
 * A local-first `live()` app — the Tier-4 v0 proof (ADR 0042): an auth-scoped **shape**
 * streams row DATA to many clients over `GET /__lesto/live-data`, and a write on one client
 * appears on every other, with NO app WebSocket code and NO app poll loop.
 *
 * The two things this example exists to prove:
 *   - **Multi-client liveness over row data.** A `POST /todos` inserts a row; the mounted
 *     `@lesto/live-server` shape engine detects it on its next full-table poll tick, diffs
 *     the shape's authorized set, and fans a `change` frame (an `insert`/`update`/
 *     delete-from-shape) to every held connection whose shape matches. The client re-renders
 *     from the streamed rows — it never refetches. (v0 detects change by polling; v1 swaps
 *     the poll for a Postgres logical-replication tap. The app code above the engine does
 *     not change.)
 *   - **Parameter-level authorization (the ADR 0042 (a) seam).** A shape names its table,
 *     columns and a structured `where` predicate as untrusted data. `authorizeShape` gates
 *     the *bound* shape against the connection's principal: the demo authorizes by the
 *     shape's bound `list=<x>` filter — the bound value IS the capability, checked
 *     server-side. A shape bound to a list the principal may not see is refused (403) at
 *     subscribe time, so it never opens a stream. The read and the write are gated by the
 *     SAME list-access rule, so no surface leaks a row the principal may not see.
 *
 * The wire here carries auth-scoped ROW DATA, never a topic — the deliberate ADR 0042 vs
 * ADR 0027/0040 split, and the reason this example drives `/__lesto/live-data` (not
 * `/__lesto/live`) and stays independent of `@lesto/live` (the browser store).
 *
 * `test/live.test.ts` extends this into the full Tier-4 v1 Inc3 acceptance-matrix dogfood
 * (ADR 0042, `L-f50f94d1`, the gallery-as-QA-gate for that increment): (a) cross-tenant
 * bound-parameter refusal (above); (c) BOTH membership-revocation mechanisms — an on-row
 * authorization column (`list`, which the shape itself filters on) reassigned away delivers a
 * sub-interval delete-from-shape with no re-auth wait, while `revokeMembership` mutates the
 * SEPARATE `MEMBERSHIP` relation the replication stream cannot observe, caught only at the next
 * re-auth interval tick — which purges the client's slice (a `resync` frame), not merely closes
 * the socket.
 */

import {
  boolean,
  createDb,
  createTableSql,
  defineTable,
  eq,
  integer,
  text,
  timestamp,
} from "@lesto/db";
import type { Db } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import { createLiveDataHttpHandlers, createShapeEngine } from "@lesto/live-server";
import type { ShapeEngine } from "@lesto/live-server";
import type { ShapeDefinition } from "@lesto/live-protocol";
import { lesto } from "@lesto/web";
import type { Context } from "@lesto/web";

/**
 * The `todos` table — the rows a `live({ table: "todos", where: [{ list }] })` shape reads
 * and re-reads live. `list` is the tenancy column the shape binds and the server authorizes.
 */
export const todos = defineTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  list: text("list").notNull(),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
});

/** The acting principal: who is connected, and which private lists they belong to. */
export interface Principal {
  readonly user: string | undefined;

  readonly lists: ReadonlySet<string>;
}

/**
 * The demo tenancy. `home` is a PUBLIC list anyone (even anonymous) may see; `work` is
 * members-only, and only `alice` is a member. A real app reads membership from its own
 * tables (a `room_members`-style join, separate from `todos`); a small MUTABLE map stands in
 * here — mutable specifically so {@link revokeMembership} can dogfood ADR 0042 acceptance (c)'s
 * cross-relation case: a membership change this relation carries is invisible to the `todos`
 * replication stream (no `todos` row changes when membership does), so it can only be caught by
 * re-invoking `authorizeShape` on the re-auth interval — never sub-interval, unlike an on-row
 * authorization column (see {@link authorizeShape} and the acceptance-matrix tests in
 * `test/live.test.ts`).
 */
const PUBLIC_LISTS: ReadonlySet<string> = new Set(["home"]);
const MEMBERSHIP: Record<string, Set<string>> = {
  alice: new Set(["work"]),
  bob: new Set<string>(),
  // `carol` exists solely for the acceptance-matrix (c) cross-relation dogfood in
  // `test/live.test.ts` (`revokeMembership`) — deliberately decoupled from `alice`'s
  // membership, which OTHER tests depend on staying intact regardless of test order.
  carol: new Set(["work"]),
};

/** Resolve a `?user=` value into its principal (its private-list membership). */
export function principalOf(user: string | undefined): Principal {
  const lists = user === undefined ? new Set<string>() : (MEMBERSHIP[user] ?? new Set<string>());

  return { user, lists };
}

/**
 * Revoke `user`'s membership in `list` — simulating an admin removing someone from a private
 * list through whatever surface a real app would use (an admin panel, another user's action).
 * The demo's ONLY mutation of the separate membership relation; nothing about any `todos` row
 * changes when this runs, which is exactly why the replication stream cannot observe it (ADR
 * 0042 acceptance (c), cross-relation case) — only a later `authorizeShape` re-check can.
 */
export function revokeMembership(user: string, list: string): void {
  MEMBERSHIP[user]?.delete(list);
}

/** May this principal SEE `list`? (public, or a member) — the one rule reads/writes/shapes share. */
export function mayAccessList(principal: Principal, list: string): boolean {
  return PUBLIC_LISTS.has(list) || principal.lists.has(list);
}

/**
 * Authorize a **bound** shape (the ADR 0042 (a) seam): the shape must be bound to a single
 * `list` via a `list = <value>` filter, and the principal must be allowed to see that list.
 * A shape with no `list=` binding is DENIED — the demo requires a bound list so that the
 * bound value is always an authorized capability, never an open read of the whole table.
 */
export function authorizeShape(principal: Principal, shape: ShapeDefinition): boolean {
  const listFilter = shape.where.find((filter) => filter.column === "list" && filter.op === "eq");

  if (listFilter === undefined) return false;

  return mayAccessList(principal, String(listFilter.value));
}

/** What {@link buildApp} returns: the booted app plus the handles the demo / tests read. */
export interface Booted {
  app: App;

  /** The shape engine the live handler subscribes through — stopped on teardown. */
  engine: ShapeEngine;

  /** The typed handle the mutation writes through and the engine polls — shared, one sqlite. */
  db: Db;

  /** Every refused (unauthorized / malformed) shape, surfaced for logging — never streamed. */
  denied: Array<{ user: string | undefined; reason: string }>;
}

/** Boot the live app: the shape stream, the gated read + write, and the demo page. */
export async function buildApp(options: {
  handle: KernelDatabase;
  /** The re-auth interval — overridden in tests so acceptance (c)/(d) don't wait 60s. */
  reauthMs?: number;
}): Promise<Booted> {
  // Wrap the kernel's handle in the typed ORM — the SAME handle the mutation writes through
  // and the engine polls, so one sqlite connection carries both (the write the poll observes).
  const db = createDb(options.handle);

  // Create the table BEFORE the engine so the first poll sees a real table, not a missing one.
  // The kernel runs no migration here (the app owns its schema for the demo).
  await db.exec(createTableSql(todos));

  const denied: Booted["denied"] = [];

  // The full-table poll interval — 50ms so a write appears "live" well inside the test's
  // 2s wait. v0's coarse floor; v1 replaces the poll with logical replication (same engine).
  const engine = createShapeEngine({ db, tables: [todos], pollMs: 50 });

  // Resolve the principal from `?user=` — a session cookie in production, but a query here
  // because a browser `EventSource` cannot set an auth header on its GET.
  const resolvePrincipal = (c: Context): Principal => principalOf(c.query("user") ?? undefined);

  const handlers = createLiveDataHttpHandlers<Principal>({
    engine,
    resolvePrincipal,
    authorizeShape,
    onDenied: (principal, reason) => {
      denied.push({ user: principal.user, reason });
    },
    // authorizeShape is re-invoked on this interval REGARDLESS (ADR 0042 acceptance (a)/(c)/(d) —
    // continuous, not connect-time-only), so a membership revoked via `revokeMembership` (a
    // relation the `todos` replication stream can't observe) is caught within this bound.
    ...(options.reauthMs === undefined ? {} : { reauthMs: options.reauthMs }),
  });

  const api = lesto()
    // The local-first row-data stream (ADR 0042). The runtime recognizes this reserved path
    // as a long-lived stream, so the held connection takes no in-flight slot and is never
    // compressed — the app just mounts the handler.
    .get("/__lesto/live-data", handlers.liveData)

    // The authorized READ — the same rows a shape streams, gated by the SAME list-access rule
    // so an inspecting client can only ever pull rows it may see.
    .get("/todos", async (c) => {
      const list = c.query("list") ?? "";
      const principal = principalOf(c.query("user") ?? undefined);

      if (!mayAccessList(principal, list)) return c.json({ error: "forbidden" }, 403);

      const rows = await db.select().from(todos).where(eq(todos.list, list)).all();

      return c.json({ todos: rows });
    })

    // The MUTATION: insert a todo into a list the principal may write. No topic to publish and
    // no fan-out to trigger — the engine's next poll tick observes the new row and streams the
    // `insert` to every subscribed client on its own.
    .post("/todos", async (c) => {
      const body = (c.req.body ?? {}) as { list?: unknown; text?: unknown };
      const list = String(body.list ?? "");
      const principal = principalOf(c.query("user") ?? undefined);

      if (!mayAccessList(principal, list)) return c.json({ error: "forbidden" }, 403);

      const todo = await db
        .insert(todos)
        .values({ list, text: String(body.text ?? ""), done: false, createdAt: new Date() })
        .returning()
        .get();

      return c.json({ todo }, 201);
    })

    // The human-facing blurb (a real UI would mount `@lesto/live`'s `live()` here).
    .get("/", () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: demoPage(),
    }));

  const app = await createApp({ db: options.handle, app: api });

  return { app, engine, db, denied };
}

/** A tiny static page describing the demo — the real live client is `@lesto/live`'s `live()`. */
function demoPage(): string {
  return [
    "<!doctype html><meta charset=utf-8><title>Lesto live() demo</title>",
    "<h1>Lesto local-first <code>live()</code> (ADR 0042 Tier 4 v0)</h1>",
    "<p>An auth-scoped shape streams row data over <code>GET /__lesto/live-data</code>;",
    "a <code>POST /todos</code> on one client appears on every other — no app socket code.</p>",
    "<p>The <code>home</code> list is public; <code>work</code> is members-only (only alice).</p>",
  ].join("\n");
}
