## ADR 0005 — Validation at the boundary, with Zod

- **Status:** Proposed (planning only — not implemented)
- **Date:** 2026-06-09
- **Deciders:** tech lead + owner

## Context

ADR 0004 retired the ActiveRecord pattern, which carried with it the
convention of *model-attached validation*:

```ts
// the old shape (gone)
class Post extends Model {
  static validations = { title: { presence: true } };
}
Post.create({ title: "" });  // returns false, populates errors
```

That mechanism is no longer available — `@volo/db`'s rows are plain
objects with no `.save()` step to gate. Phase C's identity, mailing-lists,
and blog migrations all collapsed their validation to *inline* checks:

```ts
if (input.title.trim() === "") throw new Error("Post title is required.");
```

That works for three rules across three packages. It will not scale to:

- **Admin (`packages/admin`).** The blocker for Phase C.4. Admin's whole
  promise is "give me a resource and I expose CRUD over it." It needs to
  validate `update(attrs)` payloads from generated forms, surface
  per-field errors back into the UI, and serialize them to JSON for API
  clients. Inline `throw` checks don't compose with field-level reporting.
- **HTTP controllers in general.** A `POST /posts` handler today does
  `this.request.body as { title: string; body: string }` — a cast, not a
  check. An attacker-supplied body of `{ title: 1234 }` would crash the
  controller, not return a 400. We have luck, not safety.
- **MCP tool inputs.** Agent calls cross the same boundary as HTTP. They
  need the same machine-readable, codable validation result.

The decision this ADR forces: **where does validation live now?**

## Decision

**Validation runs at the boundary, with [Zod](https://zod.dev). The model
layer never validates; the surface that accepts untrusted input does.**

Concretely:

```ts
// schemas.ts — colocated with the schema-as-value
import { z } from "zod";

export const NewPostInput = z.object({
  title: z.string().trim().min(1, "Title is required."),
  body: z.string().trim().min(1, "Body is required."),
});

export type NewPostInput = z.infer<typeof NewPostInput>;

// controller — the boundary
async create(): Promise<VoloResponse> {
  const parsed = NewPostInput.safeParse(this.request.body);

  if (!parsed.success) {
    return this.json({ ok: false, errors: parsed.error.flatten() }, 422);
  }

  const post = insertPost(this.db, parsed.data);
  return this.json({ ok: true, post });
}

// insertPost stays a typed helper — no internal validation needed,
// because the boundary already proved the shape.
```

The same `NewPostInput` flows wherever an untrusted body enters: an HTTP
controller, an MCP tool's `inputSchema`, an admin form's field set, a CLI
arg parser.

### Why Zod (and not "@volo/validate" or another library)

Three real options were on the table:

| | For | Against |
|---|---|---|
| **Zod** | De-facto TS standard; tRPC, Next, Hono, Drizzle-Zod, MCP-SDK all speak it; massive ecosystem; mature error shape | ~50KB minified; one more external dep |
| **Valibot** | ~6KB tree-shaken; modular; faster runtime | Smaller adoption; integration story still maturing; Zod's gravity makes it the convention |
| **Hand-roll `@volo/validate`** | Matches "we own our batteries" framing; no external dep | Zero leverage to be gained — validation is *solved* territory; we'd reinvent every edge case (refinements, transforms, async, error shapes) Zod already nailed; and we'd lose the Drizzle-Zod / MCP-SDK / tRPC interop the JS ecosystem already wired around Zod |

The brand-level "batteries-included" stance is preserved by *picking the
right battery and shipping it pre-wired*, not by reinventing every
dependency. Zod is the battery. Compare: we pick `scrypt` from
`node:crypto` rather than rolling our own KDF. Same call here.

We also briefly considered a **`Validator<I, O>` interface with a Zod
default** (the mailer pattern). Skipped — Zod's API is itself the
interface the ecosystem speaks; an extra adapter buys nothing and costs
clarity at every call site.

### Where validation lives, by surface

| Surface | Validates with | Error response shape |
|---|---|---|
| HTTP controller | Zod schema on `this.request.body` | 422 + `{ ok: false, errors: ZodFlattenedError }` |
| MCP tool | Zod schema as the tool's `inputSchema` (MCP-SDK consumes Zod natively) | MCP-protocol error with the schema's issues |
| Admin form | Zod schema per resource | inline per-field errors in the rendered form; same JSON shape for API clients |
| Internal helpers (`insertPost(db, input)`) | **none** — the boundary already proved the shape | n/a |
| Database row reads | **none** — the DB is trusted | n/a |

The line: validation is the *first* thing untrusted input meets, and the
*only* place it meets it. Everything past that point is typed and trusted.

### What stays out

- **No schema-attached validators on `@volo/db` tables.** The table value
  describes shape and constraints (`NOT NULL`, `UNIQUE`); semantic
  validation (length, format, business rules) is the input schema's job.
  Two values, two concerns, deliberately uncoupled.
- **No automatic table→Zod derivation.** `drizzle-zod` ships this; for
  Volo it's tempting but premature — derived schemas almost always need
  hand-customization (`NewPostInput` has `.trim().min(1)`; the column
  is just `notNull()`). When/if we want it, it's an adapter package,
  not a change to `@volo/db` or this ADR.
- **No `Result` wrapper as a convention.** Zod's own `safeParse` returns
  `{ success: true, data } | { success: false, error }`; that *is* the
  Volo result shape at the validation boundary. Callers branch on
  `parsed.success`. No extra layer.

## Admin's specific shape (the immediate motivator)

Admin today takes `{ model: typeof Model, fields: [...] }`. Under ADR 0004
+ 0005 that becomes:

```ts
interface AdminResource<TInsert, TUpdate> {
  readonly table: Table;
  readonly insertSchema: ZodSchema<TInsert>;
  readonly updateSchema: ZodSchema<TUpdate>;
  readonly fields: readonly string[];
}
```

`admin.create(attrs)` calls `insertSchema.safeParse(attrs)`, hands the
parsed data to `db.insert(table).values(parsed.data)`. `admin.update`
mirrors with `updateSchema`. Generated forms render field labels +
constraints from the schema (Zod exposes `.shape` for object schemas, so
a form generator can walk it).

That's the seam Phase C.4 needs. With it, admin moves; without it, admin
is blocked.

## Migration plan

Small, because most consumers don't *need* validation today — they
already trust their callers:

1. **Add `zod` as a workspace dep** at the root (~50KB). Single version
   across all packages.
2. **`@volo/web`: add `validateBody<S>(schema, request)`** helper that
   wraps `schema.safeParse(request.body)` and returns the parsed value
   or throws a `WebError("WEB_VALIDATION_FAILED", ...)` the per-request
   error boundary maps to 422.
3. **`packages/admin`: refactor onto the resource shape above.** Validation
   becomes a real seam, no more `model.validations` indirection. This is
   the Phase C.4 work; this ADR just unblocks it.
4. **Existing inline `throw` checks (identity, mailing-lists, blog)
   stay** — they're at internal boundaries, no untrusted input reaches
   them. We do not retroactively wrap them in Zod just to be consistent;
   the rule is "validate untrusted input," not "validate everything."
5. **Templates (`packages/create-volo`)** get one example controller
   that uses `validateBody` + a Zod schema, so the convention is the
   path of least resistance for new apps.

## Non-goals

- **Async validation / database checks** (e.g. "email must be unique").
  Zod supports `.refine()` with async predicates; we accept that.
  Identity's existing pre-check-then-insert race-catch pattern (per
  `adr-0003-auth-implemented`) is the right answer for uniqueness
  specifically. No new framework here.
- **Form generation.** Generating HTML forms from Zod is a real thing
  (`zod-form`, custom) but it's an admin concern, not a Volo-wide one.
  Comes with admin's refactor; doesn't need an ADR.
- **Replacing Zod later.** Should a clearly-better library land, the
  swap is per-package (Valibot in 2027 looks plausible). The decision is
  reversible at low cost because every schema is colocated with its
  consumer, not threaded through the data layer.

## Consequences

- Inputs that cross a trust boundary are *guaranteed* validated, by
  convention enforced at the same level as "use `db.insert(table).values()`
  for writes." A controller that does `this.request.body as { ... }` is
  now visibly wrong.
- Error shapes are machine-readable everywhere (Zod's `flatten()` /
  `format()` are stable). Frontend + admin + API consumers parse one
  shape.
- Admin moves. Without it, admin stays on `@volo/orm` and Phase D
  cannot delete that package.
- One ~50KB external dep enters the tree. Acceptable cost; verified
  against the alternative of rebuilding it and getting it wrong.
- Tests gain a third easy assertion target: `expect(parsed.success)`,
  `parsed.error.flatten()`. No new test infrastructure needed.
