/**
 * The /lab/admin/api/* zone — the @lesto/admin dogfood.
 *
 * Proves the Wave-3 admin hardening end to end on the estate playground:
 *
 *   - paginated `list` (limit + offset) returning the projected rows;
 *   - the `fields` projection allow-list (only id + declared fields leave);
 *   - the optional `onMutation` audit hook — every create/update/destroy lands
 *     an event (actor, resource, id, patch) the `GET .../audit` route surfaces;
 *   - the DB_EMPTY_UPDATE → ADMIN_EMPTY_UPDATE mapping (422) on an empty patch.
 *
 * Driven against the lab sub-app directly (`buildLabRoutes` over the node SQLite
 * content store), so this suite isolates the admin wiring from the root app's
 * CSRF / rate-limit middleware (covered by the security + production suites).
 */

import { describe, expect, it } from "vitest";

import { buildLabRoutes } from "../src/lab";
import { nodeContentStore } from "../src/content-node";
import type { Lesto } from "@lesto/web";

/** A fresh lab sub-app over a fresh in-memory store — isolated per test. */
function freshLab(): Lesto {
  return buildLabRoutes(nodeContentStore());
}

/** Create one note through the admin, returning the parsed JSON projection. */
async function createNote(
  app: Lesto,
  note: { title: string; body: string },
  role = "admin",
): Promise<Record<string, unknown>> {
  const response = await app.handle("POST", "/lab/admin/api/notes", {
    query: { role },
    body: note,
  });

  expect(response.status).toBe(200);

  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("/lab/admin/api/notes — paginated, projected CRUD", () => {
  it("creates a note and returns only id + declared fields (no leaked columns)", async () => {
    const created = await createNote(freshLab(), { title: "First", body: "one" });

    expect(created).toEqual({ id: 1, title: "First", body: "one" });
    expect(Object.keys(created)).toEqual(["id", "title", "body"]);
  });

  it("paginates list with limit + offset", async () => {
    const app = freshLab();

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
    const app = freshLab();
    await createNote(app, { title: "Old", body: "stale" });

    const response = await app.handle("PATCH", "/lab/admin/api/notes/1", {
      query: { role: "admin" },
      body: { title: "Updated" },
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ id: 1, title: "Updated", body: "stale" });
  });

  it("maps an empty update patch to ADMIN_EMPTY_UPDATE (422)", async () => {
    const app = freshLab();
    await createNote(app, { title: "Real", body: "ok" });

    const response = await app.handle("PATCH", "/lab/admin/api/notes/1", {
      query: { role: "admin" },
      body: {},
    });

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: "ADMIN_EMPTY_UPDATE" });
  });

  it("rejects an invalid create with ADMIN_VALIDATION_FAILED (422)", async () => {
    const response = await freshLab().handle("POST", "/lab/admin/api/notes", {
      query: { role: "admin" },
      body: { title: "", body: "x" },
    });

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: "ADMIN_VALIDATION_FAILED" });
  });
});

describe("/lab/admin/api/audit — the onMutation audit trail (the dogfood headline)", () => {
  it("records every create/update/destroy with actor, resource, id, and patch", async () => {
    const app = freshLab();

    await createNote(app, { title: "Audited", body: "b" }, "admin");
    await app.handle("PATCH", "/lab/admin/api/notes/1", {
      query: { role: "admin" },
      body: { title: "Edited" },
    });
    await app.handle("DELETE", "/lab/admin/api/notes/1", { query: { role: "admin" } });

    const audit = JSON.parse((await app.handle("GET", "/lab/admin/api/audit")).body) as unknown[];

    expect(audit).toEqual([
      {
        action: "create",
        actor: "admin",
        resource: "notes",
        id: 1,
        patch: { title: "Audited", body: "b" },
      },
      { action: "update", actor: "admin", resource: "notes", id: 1, patch: { title: "Edited" } },
      // A destroy has no patch — `undefined` drops out of the JSON entirely.
      { action: "destroy", actor: "admin", resource: "notes", id: 1 },
    ]);
  });

  it("attributes the audit event to the request's actor (the demo ?role knob)", async () => {
    const app = freshLab();

    await createNote(app, { title: "By guest", body: "b" }, "guest");

    const audit = JSON.parse((await app.handle("GET", "/lab/admin/api/audit")).body) as {
      actor: string;
    }[];

    expect(audit[0]?.actor).toBe("guest");
  });

  it("does NOT record an audit event when the mutation fails validation", async () => {
    const app = freshLab();

    await app.handle("POST", "/lab/admin/api/notes", {
      query: { role: "admin" },
      body: { title: "" },
    });

    const audit = JSON.parse((await app.handle("GET", "/lab/admin/api/audit")).body) as unknown[];

    expect(audit).toHaveLength(0);
  });
});
