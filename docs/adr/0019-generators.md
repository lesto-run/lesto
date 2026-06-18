# ADR 0019 — `lesto g` resource generators

- **Status:** Accepted (Increment 1 shipped)
- **Date:** 2026-06-18
- **Deciders:** tech lead + owner
- **Supersedes nothing; extends ADR 0004 (data-layer style), ADR 0005 (validation at the boundary), ADR 0011 (islands-by-default). Builds on the `@lesto/db` types ADR 0018 added (`boolean`/`timestamp`).**

## Context

Lesto scaffolds a whole project (`create-lesto` / `npm create lesto-app`) but has **no
per-resource generators**. The Rails `bin/rails generate model Post …` / Laravel
`php artisan make:model` day-one move — "one line, get a convention-correct, typed,
test-stubbed file wired into the app" — is absent. Adding a table today means
hand-writing the `@lesto/db` schema value, its `InferRow` type, a `MigrationEntry`,
and a test, copying the imports from another file and fixing them up. That is exactly
the friction a batteries-included framework exists to remove.

The shape to emit is **not** guesswork: the repo already has a canonical per-resource
convention. `examples/blog/src/post.ts` co-locates the `posts` table value, the
`Post = InferRow<typeof posts>` type, helper functions, and the create `MigrationEntry`
in **one file** (`examples/admin/src/schema.ts` does the same for two tables). Islands
have an even stronger convention: one `defineIsland` default export per file under
`app/islands/<name>.tsx`, which `lesto build`/`dev` already discover and bundle into
`/client.js` (ADR 0011, and `create-lesto`'s `islandCounter()` template). A generator's
job is to emit *that*, not to invent a new layout.

The constraint that makes this worth an ADR is the same one ADR 0018 fought: **a
generator must not smuggle in an ORM.** A code generator is where a framework is
tempted to grow an inflection engine, a `schema.rb`-style diff, a magic registry that
auto-wires every generated file. Lesto refuses all of that. The output is **plain code
the author owns** — schema-as-value, explicit `db`, plain rows (ADR 0004) — committed
to the repo and edited freely. The generator runs once and is forgotten; it is not a
runtime, not a registry, not a source of truth.

## Decision

Add a `lesto g` command (alias `lesto generate`) whose subcommands each emit a
**file-set** (the resource file + a test stub) from a `(name, field:type …)` input.
The design is **one pure planner per generator** — `(ResourceName, Field[]) →
GeneratedFile[]` — behind a thin injected filesystem seam, exactly like the existing
`lesto openapi` command (`packages/cli/src/openapi.ts`): the planner is 100%
unit-tested with no disk; the bin wires the real `fs` `exists`/`write`.

### Non-negotiable constraints

1. **Emit the existing convention, verbatim.** A generated model is byte-shaped like
   `examples/blog/src/post.ts`; a generated island like `create-lesto`'s
   `islandCounter()`. No new directory layout, no new file format. When the
   convention is ambiguous, the generator matches the *example apps*, which are the
   QA gate (see the gallery memory).
2. **Generated code compiles against the *current* `@lesto/*` API.** The `field:type`
   mapping resolves to the EXACT `@lesto/db` builders that exist today
   (`text`/`integer`/`real`/`boolean`/`timestamp` — ADR 0018 Increment 1). A
   generator never references an API that isn't shipped. The emitted import list
   carries exactly the builders the file uses (plus the always-present `integer` for
   the surrogate key), so the file has no unused imports.
3. **Plain code the author owns.** No registry, no auto-wiring, no `schema.rb` diff.
   The generator *tells* the author the one manual step (e.g. "wire
   `postMigration` into your `migrations` array") in the file's doc comment rather
   than performing magic. Wiring a generated file into `lesto.app.ts` is a human edit
   — the generator does not parse and rewrite the author's app file (that path is a
   known footgun and is explicitly deferred; see "What this is NOT").
4. **Idempotent, never destructive — but never *silent*.** A file that already exists is
   **skipped**, never clobbered or appended to. Re-running a generator after the author
   has edited what it first emitted is a no-op on that file; the generator owns no state
   to drift, the filesystem is the truth. The skip is *reported differentially* so a
   re-run is never a hidden data-loss surprise: a byte-identical file prints
   `exists <path> (unchanged)` (a true no-op), while a file whose contents have drifted —
   e.g. the author re-ran with **new fields** and the freshly-rendered output no longer
   matches — prints `exists <path> (differs — left unchanged; edit or delete to
   regenerate)`. We deliberately do **not** add a `--force` flag (it would invite the
   clobber this principle exists to forbid); the author resolves a `differs` by editing
   or deleting the file and re-running.
5. **`--dry-run` previews, writes nothing.** Every generator supports `--dry-run`:
   it prints the *real* plan and touches no disk — `would write <path>` for a file it
   would create, `would skip <path>` for one that already exists (so the preview never
   mislabels a file that a real run would leave untouched). This is the safe
   look-before-you-leap, and the same flag every CI/agent driver can use to assert a
   plan without side effects.
6. **Typed + test-stubbed.** Every generator emits a companion test that is
   *gate-green from the first run* — a model's test round-trips a row through an
   in-memory SQLite; an island's test asserts its declared name. A generated file that
   would fail the 100%-coverage gate or not compile is a generator bug.
7. **Coded errors at the boundary.** A bad generator name, resource name, or field is
   refused by a stable `CliError` code *before any file is written* — the same
   "errors carry codes" discipline as the rest of the CLI (`packages/cli/src/errors.ts`).

### The naming engine — derive every case once, never inflect at runtime

A raw name (`BlogPost`, `blog_post`, `blog-post`) is tokenized once into lowercase
words and projected into every case a template needs: `pascal` (`BlogPost`, the type /
component name), `camel` (`blogPost`, a value / variable), `snake` (`blog_post`, a file
stem), and `table` (`blog_posts`, the pluralized SQL table name). Pluralization is the
**naive English default** (`y`→`ies` after a consonant, sibilant→`es`, else `+s`) on
the **last word only**, matching the repo's `posts`/`products` tables.

Crucially, this inflector runs **once, at generation time, on output that is then
committed and editable** — it is *not* the runtime pluralizing FK inflector ADR 0018
killed. A wrong plural (`Person`→`persons`) is fixed by editing the emitted file, not
re-derived on every query. The footgun ADR 0018 named ("`references("category") →
categorys` exploding at runtime") cannot recur because the inflector never touches a
reference and never runs at runtime.

### The `field:type` grammar

A field is `name:type`. `name` is re-cased (camelCase key + snake_case column, so
`publishedAt:timestamp` → key `publishedAt`, column `published_at`). `type` is an alias
resolving to a `@lesto/db` builder:

| Alias(es) | `@lesto/db` builder | Storage / TS type (ADR 0018) |
|---|---|---|
| `string`, `text` | `text` | `TEXT` / `string` |
| `integer`, `int` | `integer` | `INTEGER` / `number` |
| `float`, `real` | `real` | `REAL` / `number` |
| `boolean`, `bool` | `boolean` | `INTEGER 0/1` / `boolean` |
| `timestamp`, `datetime` | `timestamp` | epoch-ms `INTEGER` / `Date` |

Every emitted field is `notNull()` by default (the common case; the author relaxes it
by editing). An unknown type or a non-identifier name is a coded
`CLI_GENERATE_BAD_FIELD` refusal that names the known set.

### The full generator surface

`lesto g <generator> <Name> [field:type …] [--dry-run]`, alias `lesto generate`:

| Generator | Emits | Convention source |
|---|---|---|
| **`model`** ✅ | `app/models/<name>.ts` (table value + `InferRow` type + create `MigrationEntry`) + `.test.ts` | `examples/blog/src/post.ts` |
| **`migration`** ✅ | `app/migrations/<YYYYMMDDHHMMSS>_<name>.ts` (a standalone `MigrationEntry` for a schema edit) + `.test.ts` | `migrator.ts` version scheme |
| **`island`** ✅ | `app/islands/<name>.tsx` (one `defineIsland` default export) + `.test.tsx` | `create-lesto`'s `islandCounter()` (ADR 0011) |
| **`page`** ⏳ | a `.page(path, { component })` registration | inline in `lesto.app.ts` (ADR 0004) |
| **`controller`** ⏳ | a route-group factory `(db) => lesto().get(…).post(…)` | the `lesto()` closure-factory shape |
| **`mailer`** ⏳ | a typed mail-sending function + template | (no current convention — needs design) |
| **`job`** ⏳ | a `@lesto/queue` `JobHandler` + its enqueue helper | `packages/queue`'s `JobHandler` |

✅ = shipped in Increment 1. ⏳ = designed below, deferred to a follow-on increment.

## Increment 1 (shipped): `model`, `migration`, `island`

The highest-value subset — the canonical `lesto g model Post title:string
published:boolean` acceptance, plus the two file-convention-clear neighbors. All three
are pure planners behind the `GenerateIO` seam, dispatched from the bin under
`generate`/`g` (alongside `mcp`/`openapi`, which likewise bring their own deps).

- **`model`** emits `app/models/<name>.ts` shaped exactly like `examples/blog/src/post.ts`:
  a `defineTable` value (auto-increment `id` + every field as a `notNull()` column),
  `export type <Name> = InferRow<typeof <table>>`, and an `export const
  <name>Migration: MigrationEntry` that runs `createTableSql(<table>, schema.dialect)` /
  `dropTableSql(<table>)`. **Model = table + its create migration in one file** — the
  repo's actual convention, so there is no separate migration file to keep in sync. Its
  `.test.ts` renders the DDL, asserts the migration version, and round-trips a typed row
  through an in-memory better-sqlite3 — green on the first run.
- **`migration`** emits a standalone `app/migrations/<version>_<name>.ts` — a bare
  `MigrationEntry` for a schema edit *not* tied to a new model (add-column, add-index).
  The version is `YYYYMMDDHHMMSS` from the injected clock, so migrations sort in the
  lexicographic order the migrator applies them in. The `up`/`down` bodies are `TODO`
  stubs (an honest `SELECT 1` placeholder that runs) with a worked `schema.addColumn`
  example in the comment. Extra `field:type` tokens are ignored — a schema-edit
  migration takes a name only.
- **`island`** emits `app/islands/<name>.tsx` — one `defineIsland` default export, the
  `useState` counter placeholder from `create-lesto`'s convention, with a `fallback`.
  Its `.test.tsx` asserts the island's declared `name`. (Pages, by contrast, have no
  per-file convention — they live inline in `lesto.app.ts` — which is why **island, not
  page, is the third Increment-1 generator**; page is deferred precisely because its
  "convention" is a hand-edit to the app file.)

**Dispatch, idempotency, dry-run** are shared by all three in the one `runGenerate`
core: parse + validate the generator / name / fields up front (a coded refusal touches
no disk — a duplicate field key, an unknown type, or a name with extra `:` segments all
fail here), then per planned file — `--dry-run` prints `would write`/`would skip` and
writes nothing; an existing file is read and skipped, printing `exists … (unchanged)` or
`exists … (differs — …)` per its contents (idempotent, never silent); otherwise write
and print `wrote`.

*Acceptance (met):* `lesto g model Post title:string published:boolean` writes
`app/models/post.ts` (a typed `posts` table with `text`/`boolean` columns + `Post` type
+ `postMigration`) and `app/models/post.test.ts` (a passing round-trip test); re-running
is a no-op; `--dry-run` writes nothing. 100% vitest coverage on the new CLI code.

## Deferred to a follow-on increment (designed, not built)

These are designed here so the surface is coherent, but **not implemented in Increment 1**
— each has a real open question that wants its own focused increment, not a rushed stub.

### `page`

Pages in Lesto are **not files** — a page is a `.page("/path", { component })`
registration chained onto the `lesto()` app inside `lesto.app.ts` (ADR 0004; there is no
`pages/` directory). So a `page` generator cannot just write a file: it must either
(a) emit a `app/pages/<name>.tsx` component + a `defineIsland`-style **export the author
hand-wires** into `.page(...)`, or (b) edit `lesto.app.ts` to insert the registration.
Option (b) is the app-file-rewrite footgun (see "What this is NOT") and is rejected;
option (a) needs a settled "where does a page component live and how is it imported"
convention that the codebase does not yet have. **Resolve by establishing a page-component
convention first** (likely `app/pages/<name>.tsx` exporting a component + a `PageDef`),
then generate against it.

### `controller`

A "controller" is a **route-group factory** in the post-ADR-0004 world: `(db: Db) =>
lesto().get("/things", …).post("/things", …)`, composed into the app with `.mount(...)`.
The generator would emit `app/controllers/<name>.ts` with a CRUD skeleton over a named
model (REST verbs, a Zod boundary schema per ADR 0005) + a test. The open question is the
**model linkage**: `lesto g controller Post --model post` should import the generated
`posts` table and emit typed handlers — which means the generator must read the model's
field set to scaffold the create/update schemas. That cross-generator dependency
(controller-knows-model) is the increment's real work and wants its own design.

### `mailer`

There is **no mail convention in the tree today** — `mailer` cannot emit "the existing
shape" because none exists. This generator is blocked on first designing the mail
surface (a transport seam, a typed send function, a template format). Deferred until a
mail ADR lands; listed here only so the `g` surface is complete on paper.

### `job`

A `job` maps cleanly onto `@lesto/queue`'s `JobHandler` (`packages/queue/src/types.ts`):
emit `app/jobs/<name>.ts` with a typed `JobHandler` + an `enqueue<Name>(queue, payload)`
helper + a test that runs the handler once. The open question is **payload typing** —
the queue's `JsonValue` payload wants a per-job TS type the generator should emit and
thread through both the handler and the enqueue helper. Small, well-shaped, and the
strongest candidate for the *next* increment, but out of scope for the model/migration/
island slice.

## What this is explicitly NOT

- **Not an app-file rewriter.** The generator never parses and edits `lesto.app.ts` (or
  any of the author's existing files) to "wire in" what it generated. AST-rewriting a
  user's app file is brittle (formatting, import ordering, where exactly to insert) and
  destructive in the failure case. Instead the generated file's doc comment names the
  one manual wire-up step. This is the single most important anti-magic decision.
- **Not a schema-diff / `schema.rb` generator.** Migrations stay hand-written and import
  the schema value (ADR 0004, ADR 0018). `lesto g migration` emits a *blank* migration to
  fill in; it does not diff the current DB against the schema and synthesize DDL.
- **Not a runtime registry.** Generated files are plain code committed to the repo. There
  is no manifest the generator maintains, nothing that auto-discovers "all generated
  models". `lesto build`/`dev` discover islands by the existing `app/islands/` convention,
  not by anything the generator records.
- **Not an inflection engine on references.** The pluralizer runs once at generation time
  on editable output; it is never a runtime inflector on a column reference (ADR 0018).
- **Not a template-DSL or a `.hbs`/EJS dependency.** Templates are plain TS template
  literals — pure `(ResourceName, Field[]) → string` functions, unit-tested directly, no
  new dependency (the same "no new arg-parser, no new template engine" discipline the CLI
  already holds).

## Sequencing

1. **Increment 1 (this PR):** `model` + `migration` + `island`, the naming engine, the
   `field:type` grammar, dry-run + idempotency, coded refusals, 100% coverage. The
   canonical `lesto g model Post …` acceptance lands.
2. **Increment 2:** `job` (cleanest deferred mapping — `@lesto/queue` `JobHandler`), once
   per-job payload typing is settled.
3. **Increment 3:** `controller` (needs the controller-knows-model linkage) and `page`
   (needs a page-component convention established first).
4. **Increment 4:** `mailer`, blocked on a mail-surface ADR.

## Consequences

- The day-one DX gap against Rails/Laravel closes for the highest-value resources: a new
  model is one line, typed and test-stubbed, in the repo's real convention.
- The cost is owned and small: ~one pure planner per generator + its template, behind the
  same injected-fs seam the CLI already uses, fully unit-tested. No new dependency, no
  app-file rewriting, no registry to drift.
- The deferred generators are designed, not hand-waved — each carries the specific open
  question (page-component convention, controller-model linkage, job payload typing, the
  missing mail surface) that its own increment must resolve, so "ship the rest later"
  isn't a euphemism for "undesigned".
- Generated code is plain, owned, editable code — so a generator can never become a
  source of truth, a magic registry, or an ORM in disguise. It writes a file and forgets it.
