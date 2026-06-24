/**
 * The /lab/admin/api/* zone — the @lesto/admin dogfood, now GOVERNED (OCP-4).
 *
 * Proves the Wave-3 admin hardening end to end on the estate playground, and —
 * the ADR 0028 Phase 1 headline — that a REAL session-sourced principal governs
 * every verb, with no `?role=` knob:
 *
 *   - paginated `list` (limit + offset) returning the projected rows;
 *   - the `fields` projection allow-list (only id + declared fields leave);
 *   - per-verb authz: a `viewer` may READ, only the `admin` may write — a viewer's
 *     destroy is refused `ADMIN_FORBIDDEN` (403), an unattributed request likewise;
 *   - the optional `onMutation` audit hook — every committed write lands an event
 *     attributed to the resolved `actor` the `GET .../audit` route surfaces;
 *   - the DB_EMPTY_UPDATE → ADMIN_EMPTY_UPDATE mapping (422) on an empty patch.
 *
 * Driven against the lab sub-app directly (`buildLabRoutes` over the node SQLite
 * content store), so this suite isolates the admin wiring from the root app's
 * CSRF / rate-limit middleware (covered by the security + production suites). The
 * principal resolver's session seam is injected here — "jade" is the operator
 * (admin), "guest" a read-only viewer — standing in for the identity session the
 * real node app threads (`controllers.ts`); omitting it means "no session".
 */

import { describe, expect, it } from "vitest";

import { buildLabRoutes } from "../src/lab";
import { nodeContentStore } from "../src/content-node";
import type { Lesto } from "@lesto/web";

type Store = ReturnType<typeof nodeContentStore>;

/** A lab sub-app over a given store, optionally authenticated as a demo user. */
function labFor(store: Store, as?: "jade" | "guest"): Lesto {
  return buildLabRoutes(store, as === undefined ? undefined : () => ({ userId: as }));
}

/** A fresh lab over a fresh in-memory store, optionally signed in. */
function freshLab(as?: "jade" | "guest"): Lesto {
  return labFor(nodeContentStore(), as);
}

/** Create one note through the admin (as the operator), returning the parsed projection. */
async function createNote(
  app: Lesto,
  note: { title: string; body: string },
): Promise<Record<string, unknown>> {
  const response = await app.handle("POST", "/lab/admin/api/notes", { body: note });

  expect(response.status).toBe(200);

  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("/lab/admin/api/notes — paginated, projected CRUD (as the operator)", () => {
  it("creates a note and returns only id + declared fields (no leaked columns)", async () => {
    const created = await createNote(freshLab("jade"), { title: "First", body: "one" });

    expect(created).toEqual({ id: 1, title: "First", body: "one" });
    expect(Object.keys(created)).toEqual(["id", "title", "body"]);
  });

  it("paginates list with limit + offset", async () => {
    const app = freshLab("jade");

    for (let i = 1; i <= 5; i++) {
      await createNote(app, { title: `Note ${i}`, body: "b" });
    }

    const page1 = JSON.parse(
      (await app.handle("GET", "/lab/admin/api/notes", { query: { limit: "2", offset: "0" } }))
        .body,
    ) as { id: number }[];
    const page2 = JSON.parse(
      (await app.handle("GET", "/lab/admin/api/notes", { query: { limit: "2", offset: "2" } }))
        .body,
    ) as { id: number }[];

    expect(page1.map((n) => n.id)).toEqual([1, 2]);
    expect(page2.map((n) => n.id)).toEqual([3, 4]);
  });

  it("updates a note, then the read reflects the merged state", async () => {
    const app = freshLab("jade");
    await createNote(app, { title: "Old", body: "stale" });

    const response = await app.handle("PATCH", "/lab/admin/api/notes/1", {
      body: { title: "Updated" },
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ id: 1, title: "Updated", body: "stale" });
  });

  it("maps an empty update patch to ADMIN_EMPTY_UPDATE (422)", async () => {
    const app = freshLab("jade");
    await createNote(app, { title: "Real", body: "ok" });

    const response = await app.handle("PATCH", "/lab/admin/api/notes/1", { body: {} });

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: "ADMIN_EMPTY_UPDATE" });
  });

  it("rejects an invalid create with ADMIN_VALIDATION_FAILED (422)", async () => {
    const response = await freshLab("jade").handle("POST", "/lab/admin/api/notes", {
      body: { title: "", body: "x" },
    });

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: "ADMIN_VALIDATION_FAILED" });
  });
});

describe("/lab/admin/api/notes — per-verb governance from the session (OCP-4)", () => {
  it("lets a viewer READ but refuses a destroy with ADMIN_FORBIDDEN (403)", async () => {
    // One store, two principals: the operator seeds a note, the viewer acts on it.
    const store = nodeContentStore();
    const operator = labFor(store, "jade");
    const viewer = labFor(store, "guest");

    await createNote(operator, { title: "Shared", body: "b" });

    const read = await viewer.handle("GET", "/lab/admin/api/notes");
    expect(read.status).toBe(200);
    expect((JSON.parse(read.body) as { id: number }[]).map((n) => n.id)).toEqual([1]);

    const destroy = await viewer.handle("DELETE", "/lab/admin/api/notes/1");
    expect(destroy.status).toBe(403);
    expect(JSON.parse(destroy.body)).toEqual({ error: "ADMIN_FORBIDDEN" });
  });

  it("refuses an UNATTRIBUTED read and write — deny-by-default, no ?role= knob", async () => {
    const app = freshLab(); // no session injected → no principal resolves

    const read = await app.handle("GET", "/lab/admin/api/notes");
    expect(read.status).toBe(403);
    expect(JSON.parse(read.body)).toEqual({ error: "ADMIN_FORBIDDEN" });

    const write = await app.handle("POST", "/lab/admin/api/notes", {
      body: { title: "Ghost", body: "b" },
    });
    expect(write.status).toBe(403);
    expect(JSON.parse(write.body)).toEqual({ error: "ADMIN_FORBIDDEN" });
  });
});

describe("/lab/admin/api/audit — the onMutation audit trail (the dogfood headline)", () => {
  it("records every committed write with the resolved actor, resource, id, and patch", async () => {
    const app = freshLab("jade");

    await createNote(app, { title: "Audited", body: "b" });
    await app.handle("PATCH", "/lab/admin/api/notes/1", { body: { title: "Edited" } });
    await app.handle("DELETE", "/lab/admin/api/notes/1");

    const audit = JSON.parse((await app.handle("GET", "/lab/admin/api/audit")).body) as unknown[];

    expect(audit).toEqual([
      {
        action: "create",
        // The actor is the resolved principal's id (the session), not a query knob.
        actor: "jade",
        resource: "notes",
        id: 1,
        patch: { title: "Audited", body: "b" },
      },
      { action: "update", actor: "jade", resource: "notes", id: 1, patch: { title: "Edited" } },
      // A destroy has no patch — `undefined` drops out of the JSON entirely.
      { action: "destroy", actor: "jade", resource: "notes", id: 1 },
    ]);
  });

  it("does NOT record an audit event when the mutation fails validation", async () => {
    const app = freshLab("jade");

    await app.handle("POST", "/lab/admin/api/notes", { body: { title: "" } });

    const audit = JSON.parse((await app.handle("GET", "/lab/admin/api/audit")).body) as unknown[];

    expect(audit).toHaveLength(0);
  });

  it("does NOT record an audit event for a write the policy refuses", async () => {
    const store = nodeContentStore();
    const operator = labFor(store, "jade");
    const viewer = labFor(store, "guest");

    await createNote(operator, { title: "Shared", body: "b" });
    // The viewer's destroy is refused before any commit, so no event is emitted.
    expect((await viewer.handle("DELETE", "/lab/admin/api/notes/1")).status).toBe(403);

    const audit = JSON.parse(
      (await viewer.handle("GET", "/lab/admin/api/audit")).body,
    ) as unknown[];

    expect(audit).toHaveLength(0);
  });
});
