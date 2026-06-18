# `@lesto/admin` — paginated list + `onMutation` audit hook

The generic CRUD backbone a WordPress-style admin UI sits on, wired into a
runnable Lesto app and proven end to end. This is the gallery's per-feature QA
gate for `@lesto/admin` (see `docs/plans/examples-gallery.md`): it exercises
**only** that battery's real public API, over real HTTP routes, on both axes a
unit test can't reach — **local DX** (wire it, run it) and **hosted UX** (serve
it, drive it).

It focuses on the two capabilities `@lesto/admin` shipped for data #6:

- **A paginated + projected list.** `list("products", { limit, offset })` pages by
  the primary key and projects each row to `{ id, ...fields }` — the per-resource
  `fields` allow-list plus the PK. The `products` table carries a real, writable
  `cost` column that is deliberately **left out** of `fields`, so it never leaves
  a row: projection, not cosmetics.
- **The `onMutation` audit hook.** Injected once at `createAdmin` time, it fires
  _after_ every committed create / update / destroy with an
  `{ action, actor, resource, id, patch }` event. Here it writes one row into a
  real `audit_log` table, so the trail is queryable at `GET /admin/audit` and the
  test can assert each write produced exactly the event it should.

## What it shows

A generic CRUD admin over the `createAdmin` service as HTTP routes:

| Route                                | Does                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GET /admin/products?limit=&offset=` | Paginated + projected list. `limit` defaults to 50, `offset` to 0. `cost` is never returned.                |
| `GET /admin/products/:id`            | One projected row (404 if absent).                                                                          |
| `POST /admin/products`               | Create a product. **Fires the audit hook.** Validated by the resource's `insertSchema` (422 on a bad body). |
| `PATCH /admin/products/:id`          | Update a product. **Fires the audit hook.**                                                                 |
| `DELETE /admin/products/:id`         | Destroy a product. **Fires the audit hook.**                                                                |
| `GET /admin/audit`                   | The audit trail those writes produced, newest first.                                                        |

`@lesto/admin` is a **programmatic** CRUD layer, not an HTTP surface — it hands you
`list / get / create / update / destroy` over a `@lesto/db` Table and leaves
transport to the host. `src/app.ts` is that host: it maps each verb to a route,
translates the package's stable `AdminError` codes into HTTP status (404 / 422),
and wires the `onMutation` hook to a `@lesto/db` table. The kernel
(`@lesto/kernel`) runs the table migrations on boot; `@lesto/runtime` serves it.

Pass `-H 'x-admin-actor: you@example.com'` on a write and that actor is recorded
in the audit row — the admin layer _attributes_ (it carries the actor straight
onto the event), it never authenticates.

## How to run

```bash
# In-process: dispatch the whole journey and print each response + the audit trail.
bun run examples/admin/run.ts

# Live HTTP server.
bun run examples/admin/serve.ts

# The journey test (also runs in CI via `bun run examples:test`).
bun run --cwd examples/admin test
```

## How to deploy / hosted-UX QA

`serve.ts` is a plain `node:http` server (`@lesto/runtime`'s `serve`). Boot it and
drive the journey by hand:

```bash
bun run examples/admin/serve.ts            # listens on :3000 (override with PORT=…)

# 1. Paginate — page one, then page two. No `cost` on any row.
curl 'localhost:3000/admin/products?limit=2&offset=0'
curl 'localhost:3000/admin/products?limit=2&offset=2'

# 2. Create / update / destroy — each fires the audit hook. Attribute it with a header.
curl -X POST localhost:3000/admin/products \
  -H 'content-type: application/json' -H 'x-admin-actor: ada@lesto.dev' \
  -d '{"name":"Galley Apron","price":3000,"stock":25,"cost":1100}'
curl -X PATCH localhost:3000/admin/products/6 \
  -H 'content-type: application/json' -H 'x-admin-actor: ada@lesto.dev' \
  -d '{"price":2700}'
curl -X DELETE localhost:3000/admin/products/6 -H 'x-admin-actor: ada@lesto.dev'

# 3. Read the audit trail those three writes produced.
curl localhost:3000/admin/audit
```

For a Workers deploy, the app is the same `App` object — front it with the
edge adapter instead of `serve` and back `openSqlite` with a D1/edge handle; the
admin layer and the audit hook are transport-agnostic.

## QA result (2026-06-16)

**Local DX — pass.** `run.ts` drives list → paginate → create → update → destroy →
read-audit in-process: pagination pages `[1,2] / [3,4] / [5]` by primary key,
every projected row is `{ id, name, price, stock }` (no `cost`), and the three
writes land three `audit_log` rows with the right `action` / `resource` /
`recordId` / `actor`. Typecheck, oxlint, oxfmt clean; 5 journey tests green.

**Hosted UX — pass.** Booted `serve.ts` on a real `node:http` server. Over the
wire: `GET …?limit=2&offset=0` and `…&offset=2` returned the two stable pages
with **no `cost` field**; a create→`201`, update→`200`, delete→`200` each fired
the hook; `GET /admin/audit` showed all three with `actor: grace@lesto.dev` carried
from the `x-admin-actor` header; a missing id returned **404**
(`ADMIN_RECORD_NOT_FOUND`) and a blank-name body returned **422**
(`ADMIN_VALIDATION_FAILED` with the flattened Zod field errors). Clean SIGTERM
shutdown.

## DX findings (filed back to the owning plans)

The point of the gallery is to surface friction wiring the real API. Wiring
`@lesto/admin` this time found:

1. **The `onMutation` hook is synchronous (`(e) => void`), but a real audit sink
   is async.** Persisting an audit event to a `@lesto/db` table (or any I/O sink)
   is a `Promise`, yet the hook can't `await` and the admin fires it _after_ the
   write has already committed. So the host has to fire-and-forget the insert and
   swallow its rejection (a throw would surface to the caller of a _succeeded_
   mutation). That means an audit write can silently fail or land out of order
   relative to a fast follow-up mutation, and the example can't offer
   exactly-once / ordered auditing without its own queue. A `Promise<void>`-
   returning hook (awaited inside the mutation, before it resolves) would let the
   audit row commit transactionally with the write. → _owner: `data-persistence`
   (the `@lesto/admin` audit seam)._

2. **`AuditEvent` carries the validated `patch` but not the prior state.** The
   event gives `{ action, actor, resource, id, patch }` — the _new_ attributes —
   but no `before` snapshot, so an audit trail can show "what was written" but not
   "what changed from". A diff-style audit log (the usual ask) has to re-read the
   row itself before the mutation, duplicating the `get` the admin already does
   internally on `update` / `destroy`. Threading a `before` onto the event (it's
   already fetched for the not-found pre-check) would make change-tracking free.
   → _owner: `data-persistence` (the `@lesto/admin` audit seam)._

3. **`@lesto/admin` is programmatic-only — every host re-hand-rolls the HTTP
   shell.** The package gives `list / get / create / update / destroy` and a
   coded `AdminError`, but no route layer: this example hand-wrote six routes, the
   `AdminError`-code → HTTP-status table, the `?limit=&offset=` query parsing, and
   the JSON error body. That shell is identical for every resource and every app
   that mounts the admin, so it's boilerplate the battery could ship as an opt-in
   `lesto()` sub-router (`adminRoutes(admin)` mounting standard REST paths) while
   keeping the programmatic core. Until then "wire `@lesto/admin`" means "write a
   controller," which is exactly the WordPress-style admin the package set out to
   spare you. → _owner: `data-persistence` / `web-primitives` (an admin HTTP seam)._

4. **No request error boundary, so the web layer's own `c.valid` is unusable for
   a body a route wants to reject gracefully.** `Context.valid(schema)` throws a
   `WebError` on a bad body, but `lesto().handle` / the kernel have no surrounding
   catch (the known "no request error boundary" gap), so that throw escapes
   `app.handle` unhandled rather than becoming a 422. This example sidesteps it by
   letting the admin own validation (its `ADMIN_VALIDATION_FAILED` _is_
   catchable, via the resource schema) — which is the cleaner single-authority
   design anyway — but it means `c.valid` can't be used at the boundary the way
   its doc-comment implies until a boundary exists. → _owner: `web-primitives` /
   `operability-dx` (request error boundary)._
