# ADR 0022 — Typed server mutations (server actions / typed RPC)

- **Status:** Accepted (implemented)
- **Date:** 2026-06-18
- **Deciders:** tech lead + owner
- **Supersedes nothing; builds on ADR 0005 (validation at the boundary), the `@lesto/client` contract-typed fetch design, ADR 0016 (secure-by-default kernel / `@lesto/csrf`), and the islands authoring path (ADR 0011/0012).**

## Context

Lesto can already render an island and let it fetch data over the typed
`@lesto/client` (the `LiveListing` island in `/lab` is the proof: `api.get` is
constrained to a shared contract, so the `:id` param and the `Listing` response
are end-to-end typed with no codegen). What it has **no** first-class story for is
the other half — a **mutation**: an island that wants to *change* server state can
only do one of two things today:

1. **A raw HTTP call** — `api.post("/some/route", { body })`. The body is `unknown`
   to the server until a handler `c.valid(Schema)`s it; CSRF is whatever the app
   remembered to mount; the call site re-spells the route string; the error path is
   "catch a `ClientError` and read `details.body`". Every app re-derives the same
   plumbing, and gets the security defaults wrong differently.
2. **A classic form POST** — progressive-enhancement-friendly, but untyped, and it
   navigates the page.

Meanwhile the table-stakes bar moved. **React Server Actions**, **SvelteKit remote
functions**, and **TanStack server functions** all ship the same primitive: *define
a server mutation once; call it from a component with the argument and return types
inferred end to end; the framework applies validation and CSRF at the boundary for
you.* Lesto deliberately did **not** build the `use client` / RSC transform
(routing-redesign-playground memory; `@lesto/assets` already bundles islands). So
the gap is precisely the **non-RSC** mutation primitive — the typed-RPC seam that
gives islands the server-action ergonomics **without** an RSC compiler, built **on
top of** the contract typing `@lesto/client` already proved out.

The constraints this ADR must honour, all already load-bearing elsewhere:

- **Validation lives at the boundary, and only there** (ADR 0005). A mutation
  declares a Zod input schema; the boundary parses it; the handler receives a
  parsed, typed value and never re-validates. A failure is the existing coded
  `422` shape, with the Zod issues on `details`.
- **CSRF is `@lesto/csrf`'s job — reuse it, do not reinvent it.** A mutation is a
  state-changing POST by definition, so it is exactly the request the double-submit
  token (or the `originCheck` companion) exists to guard. The primitive imports
  `verifyToken`; it does not re-implement HMAC checking.
- **Errors carry stable `code`s** (CONVENTIONS.md). The typed error path is a coded
  union, not a string — a caller branches on `error.code`, never on prose.
- **No codegen, no GraphQL, no generated client bundle.** Types cross the network
  by *inference over a contract you declare*, exactly as `createApi<Contract>()`
  does. The mutation primitive derives its client contract from the server
  definitions' own types — it does not invent a parallel typing system.

## Decision

Ship a **typed server-mutation primitive** in two halves that share one inferred
contract type, mirroring the `@lesto/client` `createApi` split:

> A **mutation** is a named, Zod-validated, CSRF-guarded server handler that
> returns a typed result. Its **client stub** is derived from the *same* TypeScript
> types the server definition carries, so the argument and return types flow end to
> end with no codegen. Every call is a same-origin `POST` to one mounted endpoint,
> answered as a **discriminated result union** — `{ ok: true; data } | { ok: false;
> error: { code, message } }` — so the typed error path is a value, not a throw.

### 1 · The define side — `@lesto/runtime` (the server seam)

`@lesto/runtime` is the transport tier that already stands the server in front of an
app; the mutation registry + boundary live here as a small, pure module
(`mutations.ts`) over the `@lesto/web` request/response and middleware seams.

```ts
import { z } from "zod";
import { defineMutation, mutationRoutes } from "@lesto/runtime";

const RenameInput = z.object({ id: z.string().min(1), name: z.string().trim().min(1) });

const rename = defineMutation({
  name: "renameListing",
  input: RenameInput,                       // the Zod schema = the wire contract
  handler: async (input, c) => {            // `input` is the PARSED { id, name }
    const listing = await store.rename(input.id, input.name);
    return { listing };                     // the typed result `data`
  },
});

// Mount every mutation under one endpoint, with CSRF + validation auto-applied.
const routes = mutationRoutes({ renameListing: rename }, { csrf });
app.route(routes);
```

- `defineMutation({ name, input, handler })` returns a `Mutation<Input, Output>`
  whose phantom `Input`/`Output` types are exactly the schema's parsed type and the
  handler's return type. `handler(input, c)` receives the **parsed** input (trusted
  past this point) and the request `Context` (so it can read the session, set
  cookies, etc.). It returns the typed result, OR throws a `MutationError(code,
  message)` to take the typed error arm deliberately.
- `mutationRoutes(map, options)` returns a `@lesto/web` sub-app (`lesto()`) that
  registers a single `POST /__lesto/mutations/:name` route. The `:name` selects the
  mutation; the route is one endpoint, not N, so adding a mutation never adds a
  route string to remember. (The `__lesto/` prefix matches the framework's other
  internal routes — `/__lesto/data/*`, `/__lesto/client-errors`.)

### 2 · The boundary — what runs per call, in order

The dispatch is fail-closed and uniform, so no mutation can be reached without
clearing every gate:

1. **Resolve the mutation by `:name`.** Unknown name → `404` `MUTATION_NOT_FOUND`
   (a typed error body, not a stack). This is a normal not-found, answered before
   any side effect.
2. **CSRF check (reused from `@lesto/csrf`).** The boundary calls `verifyToken` on
   the presented token (the `x-csrf-token` header) against the request's bound
   session, under the app's secret — the *same* check `@lesto/csrf`'s `csrf`
   middleware runs, imported, never re-implemented. A missing/forged token →
   `403` `MUTATION_CSRF_FAILED`. CSRF is **opt-in by configuration**, exactly as
   the middleware is (ADR 0016): pass `options.csrf` to enforce; omit it only when
   another layer (the `originCheck` companion in `secureStack`) already guards
   state-changing requests app-wide — the estate demo does both belt-and-braces.
3. **Zod parse (ADR 0005).** `input.safeParse(body)`; a failure → `422`
   `MUTATION_INVALID_INPUT` with the Zod issues on the error `details`. The handler
   never sees an unvalidated body.
4. **Dispatch.** `await mutation.handler(parsed, c)`; the return value is the
   `data` of the success arm.
5. **Typed error serialization.** A thrown `MutationError` becomes the failure arm
   `{ ok: false, error: { code, message } }` with the matching HTTP status; any
   other thrown value re-throws to the app's error boundary (a bug is a `500`, not
   a leaked typed error).

Every arm is JSON of the **discriminated result union**, so the HTTP status and the
body's `ok` flag always agree.

### 3 · The call side — `@lesto/client` (the typed stub)

The client half (`mutations.ts` in `@lesto/client`) derives a typed stub map from a
**mutation contract** — a `Record<name, { input; output }>` of wire types, declared
once and shared by import, exactly like `ApiContract`. The `infer*` helpers in
`@lesto/runtime` turn a `defineMutation` map into that contract type, so the app
declares the contract from its own definitions:

```ts
import { createMutationClient } from "@lesto/client";
import type { MutationContractOf } from "@lesto/runtime";

type Mutations = MutationContractOf<typeof serverMutations>;   // inferred, no codegen

const mutate = createMutationClient<Mutations>({ csrfToken });

const result = await mutate.renameListing({ id, name });       // arg typed { id, name }
if (result.ok) usethe(result.data.listing);                    // data typed
else show(result.error.code);                                  // typed error path
```

- `createMutationClient<Contract>()` returns `{ [name]: (input) => Promise<Result> }`
  where the input type is `Contract[name]["input"]` and the result is the
  discriminated union over `Contract[name]["output"]`. The stub POSTs to
  `/__lesto/mutations/:name` over `@lesto/client`'s own request path, so it inherits
  the same-origin trace propagation (ARCHITECTURE.md §7) for free.
- **The result is always returned, never thrown.** A non-2xx HTTP answer is mapped
  back into the failure arm (the server already shaped it as the union), and a
  *transport* failure (network down, non-JSON answer) is surfaced as the failure
  arm with a coded `MUTATION_TRANSPORT_FAILED` error — so a caller writes one
  `if (result.ok)` branch and never a `try/catch` around the happy path.
- **CSRF token threading.** The stub attaches the configured `csrfToken` as the
  `x-csrf-token` header on every call, so the double-submit token the page read
  from its companion cookie rides channel 2 automatically — the app never re-spells
  the header.

### Why the seam is split runtime↔client (and not one package)

The same reason `@lesto/web`/`@lesto/client` are split: the server boundary needs
`zod` and `@lesto/csrf` (Node-side checking), and `@lesto/client` must stay
**browser-safe** (native fetch, no Node deps). The shared truth is the *contract
type*, which is erased at runtime — so `MutationContractOf<typeof defs>` flows the
types across the boundary with zero runtime coupling, the same trick `ApiContract`
already uses. The client never imports the server module's *values*, only its
*types*.

## Progressive enhancement / non-RSC stance

This is explicitly **not** an RSC / `use client` transform (Lesto chose not to build
one — `@lesto/assets` bundles islands instead). A mutation is a plain typed POST an
island calls after hydration; the page is unchanged until the island runs. An app
that wants a no-JS fallback keeps the classic `<form method="post">` path
alongside — the mutation primitive is the *enhanced* path, not a replacement for the
form. Nothing here requires a compiler, a server-component boundary, or a bundler
plugin: it is closure factories + inferred types + the existing middleware onion,
consistent with ADR 0004's house style.

## Error contract

| `code` | HTTP | Meaning |
|---|---|---|
| `MUTATION_NOT_FOUND` | 404 | No mutation registered under that `:name`. |
| `MUTATION_CSRF_FAILED` | 403 | The CSRF check refused the request (missing/forged token). |
| `MUTATION_INVALID_INPUT` | 422 | The body failed the Zod input schema (issues on `details`). |
| `MUTATION_TRANSPORT_FAILED` | — | Client-side: the call could not complete or parse (network/non-JSON). |

A handler raises a **domain** error with `throw new MutationError(code, message)`,
which serializes into the same failure arm with a caller-chosen status (default
`400`) — so app-specific refusals (`LISTING_LOCKED`, say) reach the island as a
typed `error.code` exactly like the framework's own.

## Consequences

- **Islands get server-action ergonomics with no RSC.** Define once, call typed,
  validated + CSRF-guarded by construction — the differentiator parity gap closes.
- **Security defaults are not re-derived per app.** CSRF + Zod are applied at one
  boundary; the app cannot forget them on a mutation the way it can on a hand-rolled
  route.
- **One endpoint, not N routes.** `POST /__lesto/mutations/:name` keeps the router
  flat and the mutation map the single source of truth.
- **The typed error path is a value.** `{ ok }` discrimination means a caller never
  pattern-matches a thrown error to find out what went wrong.
- **Reversible + additive.** It is a new module in each package and a new (internal)
  route; nothing existing changes. An app that never calls `defineMutation` is
  byte-for-byte as before.

## Acceptance (this ADR)

- `defineMutation` + `mutationRoutes` ship in `@lesto/runtime`; `createMutationClient`
  in `@lesto/client`; the contract type flows server→client by inference (no codegen).
- A round-trip in estate's `/lab`: an island calls a typed mutation, the arg + return
  types are inferred, the typed error path is exercised, and the call is CSRF-guarded
  (a missing/forged token is a typed `403`).
- 100% coverage on both packages' new modules; estate still typechecks + builds.
